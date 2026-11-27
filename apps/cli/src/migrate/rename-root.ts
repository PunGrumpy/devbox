import { Effect, FileSystem, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { SqlClient } from "effect/sql";

import { UsageError } from "../errors.ts";
import { Output, plural } from "../output.ts";
import { ClaudeFiles, reportConflicts } from "./claude-files.ts";
import { CLAUDE_DRIVER } from "./claude-homes.ts";
import { inMigrate, writeFlags } from "./command.ts";
import {
  assertEventsEmpty,
  assertSchema,
  BASE_SCHEMA,
  databaseLayer,
  resolveProject,
  Tables,
} from "./database.ts";
import {
  type AbsolutePath,
  absolutePath,
  isUnderRoot,
  rebase,
} from "./paths.ts";
import { applyPlan, Change } from "./plan.ts";
import { assertT3Closed } from "./t3-process.ts";

const SCHEMA = {
  ...BASE_SCHEMA,
  [Tables.sessions]: ["provider_session_id", "payload_json", "driver"],
};

const Session = Schema.Struct({
  id: Schema.String,
  cwd: Schema.Unknown,
  driver: Schema.NullOr(Schema.String),
});

type Session = {
  readonly id: string;
  readonly cwd: string;
  readonly driver: string | null;
};

const sessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows =
    yield* sql`SELECT provider_session_id AS id, json_extract(payload_json, '$.cwd') AS cwd, driver
    FROM ${sql(Tables.sessions)}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Session)))
    );

  return rows.flatMap((row): Array<Session> =>
    typeof row.cwd === "string" ? [{ ...row, cwd: row.cwd }] : []
  );
});

const under = (root: AbsolutePath) =>
  Effect.map(sessions, (all) =>
    all.filter((session) => isUnderRoot(session.cwd, root))
  );

export const renameRoot = Command.make(
  "rename-root",
  {
    project: Flag.String("project").pipe(
      Flag.withDescription("project to point elsewhere, by id or title")
    ),
    to: Flag.String("to").pipe(Flag.withDescription("the new workspace root")),
    ...writeFlags,
  },
  ({ project: ref, to: toFlag, apply, yes }) =>
    inMigrate((target) =>
      Effect.gen(function* () {
        const out = yield* Output;
        const sql = yield* SqlClient.SqlClient;
        const fs = yield* FileSystem.FileSystem;
        const claudeFiles = yield* ClaudeFiles;
        const to = absolutePath(toFlag);

        if (apply && target._tag === "Live") {
          yield* assertT3Closed;
        }
        yield* assertSchema(SCHEMA);
        yield* assertEventsEmpty;
        const project = yield* resolveProject(ref);
        const from = absolutePath(project.workspaceRoot);

        if (from === to) {
          return yield* new UsageError({
            message: `"${project.title}" already has workspace root ${to}`,
          });
        }

        if (isUnderRoot(to, from) || isUnderRoot(from, to)) {
          return yield* new UsageError({
            message: `${to} is inside ${from}; the prefix rewrite would double paths`,
            hint: "move the folder out first, or rename in two steps through a sibling path",
          });
        }

        if (!(yield* fs.exists(to).pipe(Effect.orElseSucceed(() => false)))) {
          yield* out.warn(`${to} does not exist on this machine`);
        }

        const moving = yield* under(from);
        const alreadyThere = (yield* under(to)).length;
        yield* out.log(
          `project ${project.title} ${out.paint("dim", `(${project.projectId})`)}`
        );
        yield* out.line();
        yield* out.pairs([
          ["from", from],
          ["to", to],
          [
            "sessions",
            `${plural(moving.length, "session")} with cwd under the old root${alreadyThere ? `, ${alreadyThere} already under the new one` : ""}`,
          ],
        ]);
        yield* out.line();

        const cwds = [
          ...new Set(
            moving.filter((s) => s.driver === CLAUDE_DRIVER).map((s) => s.cwd)
          ),
        ];

        const copy = yield* claudeFiles.plan({ from, to, cwds });
        yield* claudeFiles.show(copy);
        yield* out.line();

        yield* applyPlan(
          target,
          { apply, yes },
          {
            change: Change.RenameRoot({ project: project.title, to }),
            prepare: claudeFiles
              .apply(copy)
              .pipe(
                Effect.flatMap((result) =>
                  Effect.addFinalizer(() =>
                    reportConflicts(result).pipe(
                      Effect.provideService(Output, out)
                    )
                  )
                )
              ),
            write: Effect.gen(function* () {
              yield* sql`UPDATE ${sql(Tables.projects)} SET workspace_root = ${to} WHERE project_id = ${project.projectId}`;

              for (const session of moving) {
                yield* sql`UPDATE ${sql(Tables.sessions)}
                SET payload_json = json_set(payload_json, '$.cwd', ${rebase(session.cwd, from, to)})
                WHERE provider_session_id = ${session.id}`;
              }
            }),
            verify: [
              {
                what: "workspace_root",
                expected: to,
                actual: sql<{
                  root: string;
                }>`SELECT workspace_root AS root FROM ${sql(Tables.projects)} WHERE project_id = ${project.projectId}`.pipe(
                  Effect.map((rows) => rows[0]?.root ?? "")
                ),
              },
              {
                what: "sessions under the old root",
                expected: 0,
                actual: Effect.map(under(from), (s) => s.length),
              },
              {
                what: "sessions under the new root",
                expected: moving.length + alreadyThere,
                actual: Effect.map(under(to), (s) => s.length),
              },
            ],
          }
        );
      }).pipe(
        Effect.provide(databaseLayer(target.path, apply ? "write" : "read"))
      )
    )
).pipe(
  Command.withDescription(
    "Point a project at a new workspace root and fix session cwd paths"
  )
);
