import { Result, Schema } from "effect";
import { join } from "node:path";
import { AbsolutePath, absolutePath } from "../migrate/paths.ts";

export const RESTIC_TAG = "agent-backup";
export const KEEP = ["--keep-daily", "7", "--keep-weekly", "4", "--keep-monthly", "6"] as const;
export const SQLITE_HEADER = "SQLite format 3\0";

const SourceName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
);
const SourceLocation = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?:~(?:\/.*)?|\$DATA(?:\/.*)?|\/.*)$/)),
);

const SourceLine = Schema.Struct({ name: SourceName, location: SourceLocation });

export const Source = Schema.Struct({ name: SourceName, path: AbsolutePath });
export type Source = typeof Source.Type;

export type SqliteSnapshot = {
  readonly source: string;
  readonly live: string;
  readonly entry: string;
};

export type BackupPlan = {
  readonly stage: AbsolutePath;
  readonly sources: ReadonlyArray<Source>;
  readonly snapshots: ReadonlyArray<SqliteSnapshot>;
};

export type SourceIssue = { readonly line: number; readonly why: string };

export type ParsedSources = {
  readonly sources: ReadonlyArray<Source>;
  readonly issues: ReadonlyArray<SourceIssue>;
};

const expand = (location: string, home: string, data: string) => {
  for (const [token, dir] of [
    ["~", home],
    ["$DATA", data],
  ] as const) {
    if (location === token) return dir;
    if (location.startsWith(`${token}/`)) return join(dir, location.slice(token.length + 1));
  }
  return location;
};

export const parseSources = (
  text: string,
  home: AbsolutePath,
  data: string = home,
): ParsedSources => {
  const sources: Array<Source> = [];
  const issues: Array<SourceIssue> = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const tokens = /^(\S+)\s+(\S.*)$/.exec(line);
    const decoded = Schema.decodeUnknownResult(SourceLine)(
      tokens === null ? undefined : { name: tokens[1], location: tokens[2] },
    );
    if (Result.isFailure(decoded)) {
      issues.push({
        line: index + 1,
        why: "expected `<name> <path>`, with a path that starts with ~, $DATA or /",
      });
      return;
    }
    const { name, location } = decoded.success;
    if (sources.some((source) => source.name === name)) {
      issues.push({ line: index + 1, why: `the name ${name} is already used` });
      return;
    }
    sources.push({ name, path: absolutePath(expand(location, home, data)) });
  });
  return { sources, issues };
};

export const hasSqliteHeader = (bytes: Uint8Array): boolean =>
  bytes.length === SQLITE_HEADER.length &&
  SQLITE_HEADER.split("").every((char, i) => bytes[i] === char.charCodeAt(0));

export const entryFor = (source: Source, live: string): string =>
  live === source.path
    ? join(source.name, live.slice(live.lastIndexOf("/") + 1))
    : join(source.name, live.slice(source.path.length + 1));

export const sidecars = (live: string): ReadonlyArray<string> => [
  live,
  `${live}-wal`,
  `${live}-shm`,
  `${live}-journal`,
];

const globEscape = (path: string) => path.replace(/[\\*?[]/g, "\\$&");

// restic expands $VARS in exclude files, so a literal $ in a path is written as $$.
export const excludeFile = (plan: BackupPlan): string =>
  plan.snapshots
    .flatMap((snapshot) => sidecars(snapshot.live))
    .map((path) => `${globEscape(path).replaceAll("$", "$$$$")}\n`)
    .join("");

export const backupArgs = (
  plan: BackupPlan,
  files: { readonly generated: string; readonly user: string },
): ReadonlyArray<string> => [
  "restic",
  "backup",
  "--tag",
  RESTIC_TAG,
  "--exclude-caches",
  "--exclude-file",
  files.generated,
  "--exclude-file",
  files.user,
  ...plan.sources.map((source) => source.path),
  plan.stage,
];

export const forgetArgs: ReadonlyArray<string> = [
  "restic",
  "forget",
  "--tag",
  RESTIC_TAG,
  "--group-by",
  "host,tags",
  ...KEEP,
  "--prune",
];

export const restoreArgs = (plan: Pick<BackupPlan, "stage">, target: string) => [
  "restic",
  "restore",
  "latest",
  "--tag",
  RESTIC_TAG,
  "--target",
  target,
  "--include",
  globEscape(plan.stage),
];

export const BACKUP_TIMEOUT_MS = 120_000;

export const sqliteBackupArgs = (live: string, dest: string): ReadonlyArray<string> => [
  "sqlite3",
  "-cmd",
  ".timeout 30000",
  live,
  `.backup "${dest.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
];

export const vacuumIntoArgs = (live: string, dest: string): ReadonlyArray<string> => [
  "sqlite3",
  live,
  `vacuum into '${dest.replaceAll("'", "''")}'`,
];

export const quickCheckArgs = (db: string): ReadonlyArray<string> => [
  "sqlite3",
  db,
  "pragma quick_check",
];
