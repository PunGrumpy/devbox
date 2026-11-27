import { join } from "node:path";

import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Data, Effect, Equal, FileSystem, Layer, Option, Schema } from "effect";
import { SqlClient, type Statement } from "effect/sql";

import { formatBytes } from "../output.ts";
import { Locations } from "./locations.ts";
import { type AbsolutePath, absolutePath } from "./paths.ts";

export const Tables = {
  projects: "projection_projects",
  threads: "orchestration_v2_projection_threads",
  sessions: "orchestration_v2_projection_provider_sessions",
  events: "orchestration_v2_events",
  scheduledTasks: "scheduled_tasks",
} as const;

export type SchemaRequirement = Readonly<Record<string, ReadonlyArray<string>>>;

export const BASE_SCHEMA: SchemaRequirement = {
  [Tables.projects]: ["project_id", "title", "workspace_root", "deleted_at"],
  [Tables.threads]: [
    "thread_id",
    "project_id",
    "title",
    "deleted_at",
    "payload_json",
    "updated_at",
  ],
  [Tables.events]: ["sequence"],
};

export type DbTarget = Data.TaggedEnum<{
  Live: { readonly path: AbsolutePath };
  Copy: { readonly path: AbsolutePath };
}>;

export const DbTarget = Data.taggedEnum<DbTarget>();

export class DatabaseNotFound extends Schema.TaggedError<DatabaseNotFound>()(
  "DatabaseNotFound",
  {
    path: Schema.String,
  }
) {
  override get message() {
    return `database not found: ${this.path}`;
  }
  get hint() {
    return "pass --db <path> or set T3_HOME";
  }
}

export class SchemaMismatch extends Schema.TaggedError<SchemaMismatch>()(
  "SchemaMismatch",
  {
    missing: Schema.Array(Schema.String),
  }
) {
  override get message() {
    return `schema mismatch, missing ${this.missing.join(", ")}`;
  }
  get hint() {
    return "T3 Code changed its database; this tool needs an update before it touches it";
  }
}

export class EventLogNotEmpty extends Schema.TaggedError<EventLogNotEmpty>()(
  "EventLogNotEmpty",
  {
    rows: Schema.Number,
  }
) {
  override get message() {
    return `${Tables.events} has ${this.rows} rows, projections may be rebuilt from it`;
  }
  get hint() {
    return "this T3 Code version keeps an event log; editing projections is no longer durable";
  }
}

export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()(
  "ProjectNotFound",
  {
    ref: Schema.String,
  }
) {
  override get message() {
    return `no project with id or title "${this.ref}"`;
  }
  get hint() {
    return "run `devbox migrate doctor` to list projects";
  }
}

export class AmbiguousProject extends Schema.TaggedError<AmbiguousProject>()(
  "AmbiguousProject",
  {
    ref: Schema.String,
    candidates: Schema.Array(
      Schema.Struct({ projectId: Schema.String, workspaceRoot: Schema.String })
    ),
  }
) {
  override get message() {
    const list = this.candidates
      .map((p) => `${p.projectId} (${p.workspaceRoot})`)
      .join(", ");

    return `"${this.ref}" names ${this.candidates.length} projects: ${list}`;
  }
  get hint() {
    return "use the project id instead of the title";
  }
}

export class BackupFailed extends Schema.TaggedError<BackupFailed>()(
  "BackupFailed",
  {
    message: Schema.String,
  }
) {}

export const resolveTarget = Effect.fn("resolveTarget")(function* (
  db: Option.Option<string>
) {
  const { liveDb } = yield* Locations;

  if (Option.isNone(db)) {
    return DbTarget.Live({ path: liveDb });
  }
  const path = absolutePath(db.value);
  const fs = yield* FileSystem.FileSystem;

  const same = yield* Effect.all([fs.stat(path), fs.stat(liveDb)]).pipe(
    Effect.map(
      ([a, b]) =>
        a.dev === b.dev && Option.isSome(a.ino) && Equal.equals(a.ino, b.ino)
    ),
    Effect.orElseSucceed(() => path === liveDb)
  );

  return same ? DbTarget.Live({ path }) : DbTarget.Copy({ path });
});

export const databaseLayer = (path: AbsolutePath, access: "read" | "write") =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* new DatabaseNotFound({ path });
      }

      return SqliteClient.layer({
        filename: path,
        readonly: access === "read",
        create: false,
        disableWAL: true,
      });
    })
  );

const Count = Schema.Array(Schema.Struct({ n: Schema.Number }));

export const count = <E, R>(
  statement: Effect.Effect<ReadonlyArray<object>, E, R>
) =>
  statement.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Count)),
    Effect.map((rows) => rows[0]?.n ?? 0)
  );

export const columnsOf = Effect.fn("columnsOf")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info(${table})`;

  return rows.map((row) => row.name);
});

export const schemaGaps = Effect.fn("schemaGaps")(function* (
  required: SchemaRequirement
) {
  const gaps: Array<string> = [];

  for (const [table, columns] of Object.entries(required)) {
    const present = yield* columnsOf(table);

    if (present.length === 0) {
      gaps.push(`table ${table}`);
    } else {
      for (const column of columns)
        if (!present.includes(column)) gaps.push(`column ${table}.${column}`);
    }
  }

  return gaps;
});

export const assertSchema = Effect.fn("assertSchema")(function* (
  required: SchemaRequirement
) {
  const missing = yield* schemaGaps(required);

  if (missing.length > 0) {
    return yield* new SchemaMismatch({ missing });
  }
});

export const eventCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return yield* count(sql`SELECT count(*) AS n FROM ${sql(Tables.events)}`);
});

export const assertEventsEmpty = Effect.gen(function* () {
  const rows = yield* eventCount;

  if (rows > 0) {
    return yield* new EventLogNotEmpty({ rows });
  }
});

export const quickCheck = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ quick_check: string }>`PRAGMA quick_check`;

  return rows.map((row) => row.quick_check).join("; ");
});

const two = (n: number) => String(n).padStart(2, "0");

const stamp = (now: Date) =>
  `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;

// Copying a WAL database with cp is unsafe; VACUUM INTO writes a consistent snapshot.
export const backup = Effect.fn("backup")(function* (source: AbsolutePath) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const { backupDir } = yield* Locations;
  yield* fs.makeDirectory(backupDir, { recursive: true });
  const path = join(backupDir, `statev2-${stamp(new Date())}.sqlite`);

  if (yield* fs.exists(path)) {
    return yield* new BackupFailed({
      message: `backup already exists: ${path}`,
    });
  }
  yield* sql`VACUUM INTO ${path}`;
  const bytes = Number((yield* fs.stat(path)).size);

  if (bytes === 0) {
    return yield* new BackupFailed({
      message: `backup failed: ${path} is empty`,
    });
  }
  if (Number((yield* fs.stat(source)).size) > 0 && bytes < 4096) {
    return yield* new BackupFailed({
      message: `backup looks wrong: ${path} is ${formatBytes(bytes)}`,
    });
  }

  return { path: absolutePath(path), bytes };
});

export const restoreHint = (backupPath: string, dbPath: string): string =>
  `restore with: cp '${backupPath}' '${dbPath}' && rm -f '${dbPath}-wal' '${dbPath}-shm'`;

export const Project = Schema.Struct({
  projectId: Schema.String,
  title: Schema.String,
  workspaceRoot: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
});

export type Project = typeof Project.Type;

const projects = (where: (sql: SqlClient.SqlClient) => Statement.Fragment) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows =
      yield* sql`SELECT project_id AS projectId, title, workspace_root AS workspaceRoot, deleted_at AS deletedAt
      FROM ${sql(Tables.projects)} ${where(sql)}`;

    return yield* Schema.decodeUnknownEffect(Schema.Array(Project))(rows);
  });

export const listProjects = projects((sql) =>
  sql.literal("ORDER BY deleted_at IS NOT NULL, title")
);

export const resolveProject = Effect.fn("resolveProject")(function* (
  ref: string
) {
  const sql = yield* SqlClient.SqlClient;
  const [byId] = yield* projects(() => sql`WHERE project_id = ${ref}`);

  if (byId) {
    return byId;
  }
  const byTitle = yield* projects(
    () => sql`WHERE title = ${ref} ORDER BY deleted_at IS NOT NULL`
  );

  const live = byTitle.filter((p) => p.deletedAt === null);
  const candidates = live.length > 0 ? live : byTitle;
  const [only, ...rest] = candidates;

  if (only === undefined) {
    return yield* new ProjectNotFound({ ref });
  }
  if (rest.length === 0) {
    return only;
  }
  return yield* new AmbiguousProject({ ref, candidates });
});
