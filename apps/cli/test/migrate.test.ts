import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";

import {
  ALPHA,
  ALPHA_ROOT,
  BETA,
  BETA_ROOT,
  GAMMA,
  makeFixture,
  query,
} from "./support/fixture.ts";
import { readJson } from "./support/json.ts";
import { devbox, migrate } from "./support/run.ts";

const DoctorReportSchema = Schema.Struct({
  schema: Schema.Struct({
    ok: Schema.Boolean,
    missing: Schema.Array(Schema.String),
  }),
  events: Schema.NullOr(Schema.Number),
  quickCheck: Schema.optional(Schema.NullOr(Schema.String)),
  projects: Schema.optional(
    Schema.Array(
      Schema.Struct({
        projectId: Schema.String,
        title: Schema.String,
        threads: Schema.Number,
        deleted: Schema.Number,
        rootExists: Schema.Boolean,
      })
    )
  ),
  issues: Schema.NullOr(
    Schema.Struct({
      threadsWithPayloadMismatch: Schema.Number,
      threadsWithoutProject: Schema.Number,
      sessionsWithMissingCwd: Schema.Number,
    })
  ),
});

const threadsOf = (db: string, projectId: string) =>
  query<{ n: number }>(
    db,
    "SELECT count(*) AS n FROM orchestration_v2_projection_threads WHERE project_id = ?",
    projectId
  )[0]?.n;

const payloadProjects = (db: string) =>
  query<{ p: string }>(
    db,
    "SELECT DISTINCT json_extract(payload_json, '$.projectId') AS p FROM orchestration_v2_projection_threads ORDER BY p"
  ).map((r) => r.p);

const rootOf = (db: string, projectId: string) =>
  query<{ r: string }>(
    db,
    "SELECT workspace_root AS r FROM projection_projects WHERE project_id = ?",
    projectId
  )[0]?.r;

describe("help and usage", () => {
  const f = makeFixture();
  test("no args prints help on stdout and exits 0", async () => {
    const r = await devbox(f.env, []);
    expect(r.code).toBe(0);
    expect(r.out).toContain("devbox <subcommand>");
    expect(r.out).toContain("migrate");
    expect(r.err).toBe("");
  });
  test("migrate without a subcommand lists them", async () => {
    const r = await migrate(f.env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("doctor");
    expect(r.out).toContain("move-threads");
    expect(r.out).toContain("rename-root");
  });
  test("command --help", async () => {
    const r = await migrate(f.env, "rename-root", "--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("devbox migrate rename-root");
    expect(r.out).toContain("--project");
  });
  test("unknown command is a usage error on stderr", async () => {
    const r = await migrate(f.env, "bogus");
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain('Error: Unknown subcommand "bogus"');
    expect(r.err).toContain("> run `devbox migrate --help`");
  });
  test("unknown flag is a usage error", async () => {
    const r = await migrate(f.env, "doctor", "--db", f.db, "--nope");
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("Error: Unrecognized flag: --nope");
  });
  test("missing database", async () => {
    const r = await migrate(f.env, "doctor", "--db", `${f.dir}/nope.sqlite`);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Error: database not found");
    expect(r.err).toContain("> pass --db <path> or set T3_HOME");
  });
});

describe("doctor", () => {
  test("renders projects, thread counts and checks", async () => {
    const f = makeFixture();
    const r = await migrate(f.env, "doctor", "--db", f.db);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toContain("✔ schema");
    expect(r.err).toContain("✔ event log empty");
    expect(r.err).toMatch(/beta-service\s+0b2e\S+\s+3\s+1\s+/u);
    expect(r.err).toContain("(missing)");
    expect(r.err).toContain("✔ thread project_id matches payload");
  });
  test("--json prints one document on stdout", async () => {
    const f = makeFixture();
    const r = await migrate(f.env, "doctor", "--db", f.db, "--json", "--check");
    expect(r.code).toBe(0);
    const report = readJson(DoctorReportSchema, r.out);
    expect(report.schema).toEqual({ ok: true, missing: [] });
    expect(report.events).toBe(0);
    expect(report.quickCheck).toBe("ok");
    expect(report.projects?.find((p) => p.projectId === BETA)).toMatchObject({
      title: "beta-service",
      threads: 3,
      deleted: 1,
      rootExists: false,
    });
    expect(report.issues).toEqual({
      threadsWithPayloadMismatch: 0,
      threadsWithoutProject: 0,
      sessionsWithMissingCwd: 4,
    });
  });
  test("reports a non-empty event log and a missing optional table", async () => {
    const f = makeFixture({ events: 2, dropSessions: true });
    const r = await migrate(f.env, "doctor", "--db", f.db);
    expect(r.code).toBe(0);
    expect(r.err).toContain("✖ event log empty  2 rows");
    expect(r.err).toContain("✔ schema");
  });
  test("a missing required table is reported, and what depends on it is not guessed", async () => {
    const f = makeFixture();
    const db = new Database(f.db, { strict: true });
    db.run("DROP TABLE orchestration_v2_events");
    db.close();
    const text = await migrate(f.env, "doctor", "--db", f.db);
    expect(text.code).toBe(0);
    expect(text.err).toContain(
      "✖ schema  missing table orchestration_v2_events"
    );
    expect(text.err).not.toContain("thread project_id matches payload");

    const jsonRun = await migrate(f.env, "doctor", "--db", f.db, "--json");
    const report = readJson(DoctorReportSchema, jsonRun.out);

    expect(report.schema).toEqual({
      ok: false,
      missing: ["table orchestration_v2_events"],
    });
    expect(report.events).toBeNull();
    expect(report.issues).toBeNull();
  });
  test("names a running T3 Code without failing", async () => {
    const f = makeFixture();

    const r = await devbox(f.env, ["migrate", "doctor", "--db", f.db], {
      t3: { pid: 4242, version: "0.1.0" },
    });

    expect(r.code).toBe(0);
    expect(r.err).toContain("✔ T3 Code running (pid 4242, 0.1.0)");
  });
  test("takes no positionals", async () => {
    const f = makeFixture();
    const r = await migrate(f.env, "doctor", "--db", f.db, "extra");
    expect(r.code).toBe(2);
  });
});

describe("move-threads", () => {
  test("dry run lists the threads and writes nothing", async () => {
    const f = makeFixture();

    const r = await migrate(
      f.env,
      "move-threads",
      "--db",
      f.db,
      "--to",
      "alpha",
      "--from",
      "beta-service",
      "--from",
      GAMMA
    );

    expect(r.code).toBe(0);
    expect(r.err).toContain("from beta-service (3), gamma-lab (0)");
    expect(r.err).toContain("to   alpha (1)");
    expect(r.err).toContain("Pipeline");
    expect(r.err).toContain("1 scheduled task still point");
    expect(r.err).toContain("3 threads to move");
    expect(r.err).toContain(
      "NOTE: dry run. Re-run with --apply to move 3 threads into alpha."
    );
    expect(threadsOf(f.db, BETA)).toBe(3);
    expect(existsSync(f.backups)).toBe(false);
  });
  test("--apply --yes moves rows, rewrites payload, backs up and verifies", async () => {
    const f = makeFixture();

    const r = await migrate(
      f.env,
      "move-threads",
      "--db",
      f.db,
      "--to",
      ALPHA,
      "--from",
      BETA,
      "--apply",
      "--yes"
    );

    expect(r.code).toBe(0);
    expect(r.err).toContain("> backup ");
    expect(r.err).toContain("> Success! move 3 threads into alpha.");
    expect(threadsOf(f.db, BETA)).toBe(0);
    expect(threadsOf(f.db, ALPHA)).toBe(4);
    expect(payloadProjects(f.db)).toEqual([ALPHA]);
    const backups = readdirSync(f.backups);
    expect(backups).toHaveLength(1);
    const [backupFile] = backups;

    if (backupFile === undefined) {
      throw new Error("expected backup file");
    }

    expect(threadsOf(path.join(f.backups, backupFile), BETA)).toBe(3);
  });
  test("--thread moves one row only", async () => {
    const f = makeFixture();

    const r = await migrate(
      f.env,
      "move-threads",
      "--db",
      f.db,
      "--to",
      "alpha",
      "--from",
      BETA,
      "--thread",
      "t-beta-2",
      "--apply",
      "--yes"
    );

    expect(r.code).toBe(0);
    expect(threadsOf(f.db, BETA)).toBe(2);
    expect(
      query<{ project_id: string }>(
        f.db,
        "SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id = 't-beta-2'"
      )[0]
    ).toEqual({ project_id: ALPHA });
  });
  test("--thread not in the source projects is a usage error", async () => {
    const f = makeFixture();

    const r = await migrate(
      f.env,
      "move-threads",
      "--db",
      f.db,
      "--to",
      "alpha",
      "--from",
      BETA,
      "--thread",
      "t-alpha-1"
    );

    expect(r.code).toBe(2);
    expect(r.err).toContain("Error: thread t-alpha-1 is not in beta-service");
  });
  test("--apply without --yes off a terminal refuses", async () => {
    const f = makeFixture();

    const r = await migrate(
      f.env,
      "move-threads",
      "--db",
      f.db,
      "--to",
      "alpha",
      "--from",
      BETA,
      "--apply"
    );

    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "Error: not a terminal, cannot ask for confirmation"
    );
    expect(r.err).toContain("> pass --yes to skip the prompt");
    expect(threadsOf(f.db, BETA)).toBe(3);
  });
  test("missing --to and same project are usage errors", async () => {
    const f = makeFixture();

    const missingTo = await migrate(
      f.env,
      "move-threads",
      "--db",
      f.db,
      "--from",
      BETA
    );

    expect(missingTo.code).toBe(2);

    const same = await migrate(
      f.env,
      "move-threads",
      "--db",
      f.db,
      "--to",
      BETA,
      "--from",
      BETA
    );

    expect(same.code).toBe(2);
    expect(same.err).toContain("--from and --to both name");
  });
  test("ambiguous title lists candidates, deleted duplicate is skipped", async () => {
    const f = makeFixture();

    const ambiguous = await migrate(
      f.env,
      "move-threads",
      "--db",
      f.db,
      "--to",
      "alpha",
      "--from",
      "No project"
    );

    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain('"No project" names 2 projects: dup-3');
    expect(ambiguous.err).toContain("use the project id instead of the title");

    const live = await migrate(
      f.env,
      "move-threads",
      "--db",
      f.db,
      "--to",
      "alpha",
      "--from",
      "delta"
    );

    expect(live.code).toBe(0);
    expect(live.err).toContain("0 threads to move");
  });
  test("a pre-existing mismatch on another thread does not fail verification", async () => {
    const f = makeFixture();
    const db = new Database(f.db, { strict: true });
    db.run(
      `UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.projectId', 'stale') WHERE thread_id = 't-alpha-1'`
    );
    db.close();

    const r = await migrate(
      f.env,
      "move-threads",
      "--db",
      f.db,
      "--to",
      ALPHA,
      "--from",
      BETA,
      "--apply",
      "--yes"
    );

    expect(r.code).toBe(0);
    expect(threadsOf(f.db, BETA)).toBe(0);
  });
  test("refuses when the event log is not empty", async () => {
    const f = makeFixture({ events: 1 });

    const r = await migrate(
      f.env,
      "move-threads",
      "--db",
      f.db,
      "--to",
      "alpha",
      "--from",
      BETA
    );

    expect(r.code).toBe(1);
    expect(r.err).toContain("Error: orchestration_v2_events has 1 rows");
  });
});

const live = () => {
  const f = makeFixture();
  const t3Home = f.env.T3_HOME;

  if (t3Home === undefined) {
    throw new Error("expected T3_HOME in fixture env");
  }

  mkdirSync(path.join(t3Home, "userdata"), { recursive: true });
  const db = path.join(t3Home, "userdata", "statev2.sqlite");
  copyFileSync(f.db, db);

  return { ...f, db };
};

describe("the live database", () => {
  const t3 = { pid: 4242, version: null };
  test("is the default, and writes refuse while T3 Code runs", async () => {
    const f = live();

    const r = await devbox(
      f.env,
      [
        "migrate",
        "move-threads",
        "--to",
        "alpha",
        "--from",
        BETA,
        "--apply",
        "--yes",
      ],
      { t3 }
    );

    expect(r.code).toBe(1);
    expect(r.err).toContain("Error: T3 Code is running (pid 4242)");
    expect(threadsOf(f.db, BETA)).toBe(3);
  });
  test("a dry run is fine while T3 Code runs", async () => {
    const f = live();

    const r = await devbox(
      f.env,
      ["migrate", "move-threads", "--to", "alpha", "--from", BETA],
      {
        t3,
      }
    );

    expect(r.code).toBe(0);
    expect(r.err).toContain("3 threads to move");
  });
  test("a copy is not the live database, so a running T3 Code does not matter", async () => {
    const f = live();

    const r = await devbox(
      f.env,
      [
        "migrate",
        "move-threads",
        "--db",
        `${f.dir}/statev2.sqlite`,
        "--to",
        "alpha",
        "--from",
        BETA,
        "--apply",
        "--yes",
      ],
      { t3 }
    );

    expect(r.code).toBe(0);
    expect(threadsOf(f.db, BETA)).toBe(3);
  });
});

describe("rename-root", () => {
  test("dry run counts sessions under the old root", async () => {
    const f = makeFixture();

    const r = await migrate(
      f.env,
      "rename-root",
      "--db",
      f.db,
      "--project",
      "alpha",
      "--to",
      "/Users/me/Projects/alpha"
    );

    expect(r.code).toBe(0);
    expect(r.err).toContain(`from      ${ALPHA_ROOT}`);
    expect(r.err).toContain("to        /Users/me/Projects/alpha");
    expect(r.err).toContain("3 sessions with cwd under the old root");
    expect(r.err).toContain("WARN! /Users/me/Projects/alpha does not exist");
    expect(r.err).toContain("NOTE: dry run");
  });
  test("--apply rewrites the project root and every session cwd beneath it", async () => {
    const f = makeFixture();

    const r = await migrate(
      f.env,
      "rename-root",
      "--db",
      f.db,
      "--project",
      ALPHA,
      "--to",
      "/Users/me/Projects/alpha/",
      "--apply",
      "--yes"
    );

    expect(r.code).toBe(0);
    expect(r.err).toContain(
      "> Success! rename the root of alpha to /Users/me/Projects/alpha."
    );
    expect(rootOf(f.db, ALPHA)).toBe("/Users/me/Projects/alpha");
    expect(
      query<{ id: string; cwd: string | null }>(
        f.db,
        "SELECT provider_session_id AS id, json_extract(payload_json, '$.cwd') AS cwd FROM orchestration_v2_projection_provider_sessions ORDER BY id"
      )
    ).toEqual([
      { id: "s-1", cwd: "/Users/me/Projects/alpha" },
      { id: "s-2", cwd: "/Users/me/Projects/alpha/Beta-Service" },
      { id: "s-3", cwd: "/Users/me/Projects/alpha/Beta-Service/sub" },
      { id: "s-4", cwd: "/Users/me/Developments/alpha-cli" },
      { id: "s-5", cwd: null },
    ]);
    expect(rootOf(f.db, BETA)).toBe(BETA_ROOT);
    expect(readdirSync(f.backups)).toHaveLength(1);
  });
  test("nested roots are refused", async () => {
    const f = makeFixture();

    const nested = await migrate(
      f.env,
      "rename-root",
      "--db",
      f.db,
      "--project",
      "alpha",
      "--to",
      `${ALPHA_ROOT}/inner`,
      "--apply",
      "--yes"
    );

    expect(nested.code).toBe(2);
    expect(nested.err).toContain("is inside");

    const enclosing = await migrate(
      f.env,
      "rename-root",
      "--db",
      f.db,
      "--project",
      BETA,
      "--to",
      ALPHA_ROOT
    );

    expect(enclosing.code).toBe(2);
    expect(rootOf(f.db, ALPHA)).toBe(ALPHA_ROOT);
  });
  test("same root and missing flags are usage errors", async () => {
    const f = makeFixture();

    const sameRoot = await migrate(
      f.env,
      "rename-root",
      "--db",
      f.db,
      "--project",
      "alpha",
      "--to",
      ALPHA_ROOT
    );

    expect(sameRoot.code).toBe(2);

    const missingProject = await migrate(
      f.env,
      "rename-root",
      "--db",
      f.db,
      "--to",
      "/x"
    );

    expect(missingProject.code).toBe(2);

    const missingTo = await migrate(
      f.env,
      "rename-root",
      "--db",
      f.db,
      "--project",
      "alpha"
    );

    expect(missingTo.code).toBe(2);
  });
  test("refuses when the sessions table is gone", async () => {
    const f = makeFixture({ dropSessions: true });

    const r = await migrate(
      f.env,
      "rename-root",
      "--db",
      f.db,
      "--project",
      "alpha",
      "--to",
      "/x"
    );

    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "Error: schema mismatch, missing table orchestration_v2_projection_provider_sessions"
    );
  });
});
