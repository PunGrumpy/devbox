import { Data, Effect, FileSystem, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { SqlClient } from "effect/sql";

import { Output, plural } from "../output.ts";
import { strandedMemory } from "./claude-files.ts";
import type { StrandedMemory } from "./claude-files.ts";
import { CLAUDE_DRIVER, ClaudeHomes } from "./claude-homes.ts";
import { inMigrate } from "./command.ts";
import {
  BASE_SCHEMA,
  columnsOf,
  count,
  databaseLayer,
  eventCount,
  listProjects,
  quickCheck,
  schemaGaps,
  Tables,
} from "./database.ts";
import type { Project } from "./database.ts";
import { T3Process } from "./t3-process.ts";
import type { RunningServer } from "./t3-process.ts";

type ProjectRow = Project & {
  readonly threads: number;
  readonly deleted: number;
  readonly rootExists: boolean;
};

type Issues = {
  readonly threadsWithPayloadMismatch: number;
  readonly threadsWithoutProject: number;
  readonly sessionsWithMissingCwd: number;
};

type QuickCheck = Data.TaggedEnum<{
  Skipped: {};
  Ran: { readonly result: string };
}>;

const QuickCheck = Data.taggedEnum<QuickCheck>();

type MemoryCheck = Data.TaggedEnum<{
  Checked: { readonly entries: readonly StrandedMemory[] };
  Unchecked: { readonly reason: string };
}>;

const MemoryCheck = Data.taggedEnum<MemoryCheck>();

type Inspection = Data.TaggedEnum<{
  Incomplete: { readonly missing: readonly string[] };
  Complete: {
    readonly events: number;
    readonly projects: readonly ProjectRow[];
    readonly issues: Issues;
    readonly memory: MemoryCheck;
  };
}>;

const Inspection = Data.taggedEnum<Inspection>();

type Report = {
  readonly database: string;
  readonly server: Option.Option<RunningServer>;
  readonly quickCheck: QuickCheck;
  readonly inspection: Inspection;
};

const Cwd = Schema.Array(Schema.Struct({ cwd: Schema.Unknown }));

const strings = (rows: readonly { readonly cwd: unknown }[]) =>
  rows.flatMap((row) => (typeof row.cwd === "string" ? [row.cwd] : []));

const inspect = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const out = yield* Output;

  const counts = new Map(
    (yield* sql<{ projectId: string; threads: number; deleted: number }>`
      SELECT project_id AS projectId, count(*) AS threads, sum(deleted_at IS NOT NULL) AS deleted
      FROM ${sql(Tables.threads)} GROUP BY project_id`).map((row) => [
      row.projectId,
      row,
    ])
  );

  const projects = yield* Effect.forEach(yield* listProjects, (project) =>
    Effect.map(
      fs.exists(project.workspaceRoot).pipe(Effect.orElseSucceed(() => false)),
      (rootExists) => ({
        ...project,
        threads: counts.get(project.projectId)?.threads ?? 0,
        deleted: counts.get(project.projectId)?.deleted ?? 0,
        rootExists,
      })
    )
  );

  const sessionColumns = yield* columnsOf(Tables.sessions);

  const cwds = sessionColumns.includes("payload_json")
    ? strings(
        yield* sql`SELECT DISTINCT json_extract(payload_json, '$.cwd') AS cwd FROM ${sql(Tables.sessions)} WHERE cwd IS NOT NULL`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Cwd))
        )
      )
    : [];

  const claudeCwds =
    sessionColumns.includes("payload_json") && sessionColumns.includes("driver")
      ? strings(
          yield* sql`SELECT DISTINCT json_extract(payload_json, '$.cwd') AS cwd FROM ${sql(Tables.sessions)}
            WHERE driver = ${CLAUDE_DRIVER} AND cwd IS NOT NULL`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Cwd))
          )
        )
      : [];

  const memory = yield* strandedMemory(
    projects.filter((project) => project.deletedAt === null),
    claudeCwds
  ).pipe(
    Effect.map((entries) => MemoryCheck.Checked({ entries })),
    Effect.catch((error) =>
      Effect.as(
        out.warn(`Claude memory not checked: ${error.message}`),
        MemoryCheck.Unchecked({ reason: error.message })
      )
    )
  );

  const missingCwds = yield* Effect.filter(cwds, (cwd) =>
    Effect.map(
      fs.exists(cwd).pipe(Effect.orElseSucceed(() => false)),
      (found) => !found
    )
  );

  return Inspection.Complete({
    events: yield* eventCount,
    projects,
    memory,
    issues: {
      threadsWithPayloadMismatch: yield* count(
        sql`SELECT count(*) AS n FROM ${sql(Tables.threads)} WHERE json_extract(payload_json, '$.projectId') IS NOT project_id`
      ),
      threadsWithoutProject: yield* count(
        sql`SELECT count(*) AS n FROM ${sql(Tables.threads)} t LEFT JOIN ${sql(Tables.projects)} p ON p.project_id = t.project_id WHERE p.project_id IS NULL`
      ),
      sessionsWithMissingCwd: missingCwds.length,
    },
  });
});

const collect = (database: string, check: boolean) =>
  Effect.gen(function* () {
    const out = yield* Output;
    const homes = yield* ClaudeHomes;

    if (Option.isSome(homes.configDirElsewhere)) {
      yield* out.warn(
        `CLAUDE_CONFIG_DIR is ${homes.configDirElsewhere.value} here, but Claude instances without a homePath are read from ${homes.defaultHome}; pass --claude-home if T3 Code uses the other one`
      );
    }

    const missing = yield* schemaGaps(BASE_SCHEMA);
    const server = yield* (yield* T3Process).running;

    const quick = check
      ? QuickCheck.Ran({ result: yield* out.step("quick_check", quickCheck) })
      : QuickCheck.Skipped();

    const inspection =
      missing.length > 0 ? Inspection.Incomplete({ missing }) : yield* inspect;

    return { database, server, quickCheck: quick, inspection } satisfies Report;
  });

const toJson = (report: Report) => {
  const complete = Inspection.$is("Complete")(report.inspection)
    ? report.inspection
    : undefined;

  return {
    database: report.database,
    server: Option.match(report.server, {
      onNone: () => ({ running: false, pid: null, version: null }),
      onSome: ({ pid, version }) => ({ running: true, pid, version }),
    }),
    schema: Inspection.$match(report.inspection, {
      Incomplete: ({ missing }) => ({ ok: false, missing }),
      Complete: () => ({ ok: true, missing: [] }),
    }),
    events: complete?.events ?? null,
    quickCheck: QuickCheck.$match(report.quickCheck, {
      Skipped: () => null,
      Ran: ({ result }) => result,
    }),
    projects: complete?.projects ?? [],
    strandedMemory:
      complete === undefined
        ? null
        : MemoryCheck.$match(complete.memory, {
            Checked: ({ entries }) => entries,
            Unchecked: () => null,
          }),
    issues: complete?.issues ?? null,
  };
};

const render = (report: Report) =>
  Effect.gen(function* () {
    const out = yield* Output;
    const dim = (text: string) => out.paint("dim", text);
    yield* out.log(`database ${report.database}`);
    yield* Option.match(report.server, {
      onNone: () => out.check(true, "T3 Code closed"),
      onSome: ({ pid, version }) =>
        out.check(
          true,
          `T3 Code running (pid ${pid}${version ? `, ${version}` : ""})`,
          "read-only commands are fine, writes need it closed"
        ),
    });
    yield* Inspection.$match(report.inspection, {
      Incomplete: ({ missing }) =>
        out.check(false, "schema", `missing ${missing.join(", ")}`),
      Complete: () => out.check(true, "schema"),
    });

    const complete = Inspection.$is("Complete")(report.inspection)
      ? report.inspection
      : undefined;

    if (complete !== undefined) {
      yield* out.check(
        complete.events === 0,
        "event log empty",
        complete.events > 0
          ? `${complete.events} rows, projection edits would not be durable`
          : undefined
      );
    }

    yield* QuickCheck.$match(report.quickCheck, {
      Skipped: () =>
        out.check(
          true,
          { text: "quick_check skipped", tone: "dim" },
          "pass --check to read the whole file"
        ),
      Ran: ({ result }) =>
        out.check(
          result === "ok",
          "quick_check",
          result === "ok" ? undefined : result
        ),
    });
    yield* out.line();

    if (complete === undefined) {
      return yield* out.log(dim("the other checks need the tables above"));
    }

    if (complete.projects.length > 0) {
      yield* out.table<ProjectRow>(
        [
          {
            header: "project",
            cell: (p) =>
              p.deletedAt ? { text: p.title, tone: "gray" } : p.title,
          },
          { header: "id", cell: (p) => ({ text: p.projectId, tone: "dim" }) },
          { header: "threads", cell: (p) => String(p.threads), align: "right" },
          {
            header: "deleted",
            cell: (p) => ({
              text: String(p.deleted),
              tone: p.deleted ? "yellow" : "dim",
            }),
            align: "right",
          },
          {
            header: "workspace root",
            cell: (p) =>
              p.rootExists
                ? p.workspaceRoot
                : [
                    { text: p.workspaceRoot, tone: "red" },
                    " ",
                    { text: "(missing)", tone: "dim" },
                  ],
          },
        ],
        complete.projects
      );
      yield* out.line();
    }

    const { issues } = complete;
    yield* out.check(
      issues.threadsWithPayloadMismatch === 0,
      "thread project_id matches payload",
      `${issues.threadsWithPayloadMismatch} mismatched`
    );
    yield* out.check(
      issues.threadsWithoutProject === 0,
      "every thread has a project",
      `${issues.threadsWithoutProject} orphaned`
    );
    yield* out.check(
      issues.sessionsWithMissingCwd === 0,
      "session cwd paths exist",
      `${issues.sessionsWithMissingCwd} missing on disk`
    );
    yield* MemoryCheck.$match(complete.memory, {
      Unchecked: () =>
        out.check(
          false,
          "Claude memory under the live slug",
          "not checked, see the warning above"
        ),
      Checked: ({ entries }) =>
        Effect.gen(function* () {
          const missingFiles = entries.reduce((sum, m) => sum + m.missing, 0);
          yield* out.check(
            missingFiles === 0,
            "Claude memory under the live slug",
            `${plural(missingFiles, "file")} only under a symlink spelling`
          );

          if (entries.length === 0) {
            return;
          }

          yield* out.line();
          yield* out.table<StrandedMemory>(
            [
              { header: "project", cell: (m) => m.project },
              { header: "home", cell: (m) => m.home },
              { header: "slug as spelled", cell: (m) => m.unresolvedSlug },
              { header: "files", cell: (m) => String(m.files), align: "right" },
              {
                header: "in live slug",
                cell: (m) => String(m.liveFiles),
                align: "right",
              },
              {
                header: "missing there",
                cell: (m) => ({
                  text: String(m.missing),
                  tone: m.missing ? "yellow" : "dim",
                }),
                align: "right",
              },
            ],
            entries
          );
          yield* out.line();
          yield* out.log(
            "These slugs come from a path spelled through a symlink. Delete none of them: on another machine they can be the live ones."
          );
        }),
    });
  });

export const doctor = Command.make(
  "doctor",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("print the report as JSON on stdout"),
      Flag.withDefault(false)
    ),
    check: Flag.Boolean("check").pipe(
      Flag.withDescription(
        "also run PRAGMA quick_check, which reads the whole file"
      ),
      Flag.withDefault(false)
    ),
  },
  ({ json, check }) =>
    inMigrate((target) =>
      Effect.gen(function* () {
        const report = yield* collect(target.path, check).pipe(
          Effect.provide(databaseLayer(target.path, "read"))
        );

        if (json) {
          yield* (yield* Output).json(toJson(report));
        } else {
          yield* render(report);
        }
      })
    )
).pipe(
  Command.withDescription(
    "Check the database, list projects with thread counts (read-only)"
  )
);
