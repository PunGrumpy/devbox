import { Database } from "bun:sqlite";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

export const ALPHA = "0a1f0000-0000-4000-8000-00000000a1fa";
export const BETA = "0b2e0000-0000-4000-8000-00000000be7a";
export const GAMMA = "mcp:0c3d0000-0000-4000-8000-0000000004a3";
export const ALPHA_ROOT = "/Users/me/Developments/alpha";
export const BETA_ROOT = "/Users/me/Developments/alpha/Beta-Service";

export const SCHEMA_0_1_6_NIGHTLY_20261031 = `
CREATE TABLE projection_projects (
  project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL,
  scripts_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
  deleted_at TEXT, default_model_selection_json TEXT, default_thread_env_mode TEXT, favicon_path TEXT,
  auto_pull INTEGER NOT NULL DEFAULT 0, project_icon_json TEXT, pinned_at TEXT, archived_at TEXT);
CREATE TABLE orchestration_v2_projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  default_provider TEXT NOT NULL DEFAULT 'claudeAgent', runtime_mode TEXT NOT NULL DEFAULT 'full-access',
  interaction_mode TEXT NOT NULL DEFAULT 'default', active_provider_thread_id TEXT,
  created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', archived_at TEXT, deleted_at TEXT,
  payload_json TEXT NOT NULL, provider_instance_id TEXT);
CREATE INDEX orchestration_v2_projection_threads_project_updated_idx ON orchestration_v2_projection_threads(project_id, updated_at);
CREATE TABLE orchestration_v2_projection_provider_sessions (
  provider_session_id TEXT PRIMARY KEY, thread_id TEXT, provider TEXT NOT NULL DEFAULT 'claudeAgent',
  status TEXT NOT NULL DEFAULT 'ready', model TEXT, updated_at TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL,
  driver TEXT, provider_instance_id TEXT);
CREATE TABLE orchestration_v2_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, command_id TEXT,
  thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, provider TEXT, raw_event_id TEXT,
  event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL, driver TEXT, provider_instance_id TEXT);
CREATE TABLE scheduled_tasks (
  task_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
  schedule_json TEXT NOT NULL DEFAULT '{}', project_id TEXT NOT NULL, thread_id TEXT,
  workspace_strategy_json TEXT NOT NULL DEFAULT '{}', model_selection_json TEXT NOT NULL DEFAULT '{}',
  runtime_mode TEXT NOT NULL DEFAULT 'full-access', interaction_mode TEXT NOT NULL DEFAULT 'default',
  created_by TEXT NOT NULL DEFAULT 'user', creation_source TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', next_run_at TEXT, last_run_at TEXT,
  last_run_status TEXT NOT NULL DEFAULT 'idle', last_run_error TEXT, run_count INTEGER NOT NULL DEFAULT 0);
`;

const sessionPayload = (cwd: string) =>
  JSON.stringify({ id: "s", status: "ready", cwd, model: "m" });

export type Fixture = { dir: string; db: string; backups: string; env: Record<string, string> };

export const makeFixture = (options: { events?: number; dropSessions?: boolean } = {}): Fixture => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "devbox-migrate-")));
  const path = join(dir, "statev2.sqlite");
  const db = new Database(path, { create: true, strict: true });
  db.exec(SCHEMA_0_1_6_NIGHTLY_20261031);
  const project = db.query(
    "INSERT INTO projection_projects (project_id, title, workspace_root, deleted_at) VALUES (?, ?, ?, ?)",
  );
  project.run(ALPHA, "alpha", ALPHA_ROOT, null);
  project.run(BETA, "beta-service", BETA_ROOT, null);
  project.run(GAMMA, "gamma-lab", "/Users/me/Developments/alpha/gamma-lab", null);
  project.run("dup-1", "delta", "/Users/me/old/delta", "2026-10-01T00:00:00Z");
  project.run("dup-2", "delta", "/Users/me/Projects/delta", null);
  project.run("dup-3", "No project", "/Users/me/.t3/scratch", null);
  project.run("dup-4", "No project", "/Users/me/.t3/scratch", null);

  const thread = db.query(
    "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, updated_at, deleted_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const add = (
    id: string,
    projectId: string,
    title: string,
    updatedAt: string,
    deletedAt: string | null,
  ) =>
    thread.run(
      id,
      projectId,
      title,
      updatedAt,
      deletedAt,
      JSON.stringify({ id, projectId, title, createdBy: "user", worktreePath: null }),
    );
  add("t-alpha-1", ALPHA, "Onboarding", "2026-10-20T00:00:00Z", null);
  add("t-beta-1", BETA, "Pipeline", "2026-10-22T00:00:00Z", null);
  add("t-beta-2", BETA, "Image build", "2026-10-21T00:00:00Z", null);
  add("t-beta-3", BETA, "Old", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z");

  if (options.dropSessions) {
    db.exec("DROP TABLE orchestration_v2_projection_provider_sessions");
  } else {
    const session = db.query(
      "INSERT INTO orchestration_v2_projection_provider_sessions (provider_session_id, thread_id, payload_json) VALUES (?, ?, ?)",
    );
    session.run("s-1", "t-alpha-1", sessionPayload(ALPHA_ROOT));
    session.run("s-2", "t-beta-1", sessionPayload(BETA_ROOT));
    session.run("s-3", "t-beta-2", sessionPayload(`${BETA_ROOT}/sub`));
    session.run("s-4", "x", sessionPayload("/Users/me/Developments/alpha-cli"));
    session.run("s-5", "y", JSON.stringify({ id: "s", status: "ready" }));
  }
  db.query("INSERT INTO scheduled_tasks (task_id, project_id) VALUES (?, ?)").run("task-1", BETA);
  for (let i = 0; i < (options.events ?? 0); i += 1) {
    db.query(
      "INSERT INTO orchestration_v2_events (event_id, thread_id, event_type, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?)",
    ).run(`e-${i}`, "t-alpha-1", "x", "", "{}");
  }
  db.close();
  const backups = join(dir, "backups");
  return {
    dir,
    db: path,
    backups,
    env: { HOME: join(dir, "home"), T3_HOME: join(dir, "no-t3"), T3_BACKUP_DIR: backups },
  };
};

export const query = <T>(
  path: string,
  sql: string,
  ...params: Array<string | number>
): Array<T> => {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    return db.query<T, Array<string | number>>(sql).all(...params);
  } finally {
    db.close();
  }
};

export type World = {
  base: string;
  home: string;
  real: string;
  t3: string;
  db: string;
  homes: { a: string; b: string };
  env: Record<string, string>;
};

export const slug = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");

export const makeWorld = (): World => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "devbox-migrate-world-")));
  const home = join(base, "home");
  const real = join(base, "real", "Developments");
  const t3 = join(home, ".t3");
  const homes = { a: join(home, ".claude-a"), b: join(home, ".claude-b") };
  for (const dir of [home, real, join(t3, "userdata"), homes.a, homes.b])
    mkdirSync(dir, { recursive: true });
  symlinkSync(real, join(home, "Developments"));
  symlinkSync(homes.b, join(home, ".claude-b-alias"));
  writeFileSync(
    join(t3, "userdata", "settings.json"),
    JSON.stringify({
      providerInstances: {
        claudeAgent_a: { driver: "claudeAgent", config: { homePath: "~/.claude-a" } },
        claudeAgent_b: { driver: "claudeAgent", config: { homePath: homes.b } },
        claudeAgent_a_again: { driver: "claudeAgent", config: { homePath: `${homes.a}/` } },
        claudeAgent_b_alias: { driver: "claudeAgent", config: { homePath: "~/.claude-b-alias" } },
        claudeAgent: { driver: "claudeAgent", enabled: false, config: { homePath: "" } },
        codex_x: { driver: "codex", config: { homePath: join(home, ".codex-x") } },
      },
    }),
  );
  const db = join(t3, "userdata", "statev2.sqlite");
  const conn = new Database(db, { create: true, strict: true });
  conn.exec(SCHEMA_0_1_6_NIGHTLY_20261031);
  conn.close();
  return {
    base,
    home,
    real,
    t3,
    db,
    homes,
    env: { HOME: home, T3_HOME: t3, T3_BACKUP_DIR: join(base, "backups") },
  };
};

export const addProject = (
  world: World,
  id: string,
  title: string,
  root: string,
  cwds: Array<{ cwd: string; driver?: string }> = [],
): void => {
  const conn = new Database(world.db, { strict: true });
  conn
    .query("INSERT INTO projection_projects (project_id, title, workspace_root) VALUES (?, ?, ?)")
    .run(id, title, root);
  cwds.forEach(({ cwd, driver }, i) => {
    conn
      .query(
        "INSERT INTO orchestration_v2_projection_provider_sessions (provider_session_id, thread_id, payload_json, driver) VALUES (?, ?, ?, ?)",
      )
      .run(`${id}-s${i}`, `${id}-t${i}`, JSON.stringify({ cwd }), driver ?? "claudeAgent");
  });
  conn.close();
};

export const putFiles = (dir: string, files: Record<string, string>): void => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
};

export const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const rel = relative(dir, full);
      if (entry.isDirectory()) {
        out[rel] = "dir";
        walk(full);
      } else if (entry.isSymbolicLink()) out[rel] = `link ${readlinkSync(full)}`;
      else out[rel] = `${Bun.hash(readFileSync(full))} @${lstatSync(full).mtimeMs}`;
    }
  };
  walk(dir);
  return out;
};
