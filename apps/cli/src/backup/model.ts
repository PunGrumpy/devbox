import { basename, join } from "node:path";

import { Result, Schema } from "effect";

import { AbsolutePath, absolutePath } from "../migrate/paths.ts";

export const RESTIC_TAG = "agent-backup";

export const KEEP = [
  "--keep-daily",
  "7",
  "--keep-weekly",
  "4",
  "--keep-monthly",
  "6",
] as const;

export const SQLITE_HEADER = "SQLite format 3\0";

const SourceName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/))
);

const SourceLocation = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?:~(?:\/.*)?|\$DATA(?:\/.*)?|\/.*)$/))
);

const SourceLine = Schema.Struct({
  name: SourceName,
  location: SourceLocation,
});

export const Source = Schema.Struct({ name: SourceName, path: AbsolutePath });

export type Source = typeof Source.Type;

export const MANIFEST = ".manifest.json";

export const ManifestEntry = Schema.Struct({
  source: SourceName,
  path: Schema.String,
  relative: Schema.String,
});

export type ManifestEntry = typeof ManifestEntry.Type;

export const Manifest = Schema.Array(ManifestEntry);

export type SqliteSnapshot = ManifestEntry & {
  readonly live: string;
  readonly entry: string;
};

export interface BackupPlan {
  readonly stage: AbsolutePath;
  readonly sources: readonly Source[];
  readonly snapshots: readonly SqliteSnapshot[];
}

export interface SourceIssue {
  readonly line: number;
  readonly why: string;
}

export interface ParsedSources {
  readonly sources: readonly Source[];
  readonly issues: readonly SourceIssue[];
}

const expand = (location: string, home: string, data: string) => {
  for (const [token, dir] of [
    ["~", home],
    ["$DATA", data],
  ] as const) {
    if (location === token) {
      return dir;
    }

    if (location.startsWith(`${token}/`)) {
      return join(dir, location.slice(token.length + 1));
    }
  }

  return location;
};

export const parseSources = (
  text: string,
  home: AbsolutePath,
  data: string = home
): ParsedSources => {
  const sources: Source[] = [];
  const issues: SourceIssue[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();

    if (line === "" || line.startsWith("#")) {
      return;
    }

    const tokens = /^(\S+)\s+(\S.*)$/.exec(line);

    const decoded = Schema.decodeUnknownResult(SourceLine)(
      tokens === null ? undefined : { name: tokens[1], location: tokens[2] }
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

export const stagedEntry = ({
  source,
  path,
  relative,
}: ManifestEntry): string =>
  join(source, relative === "" ? basename(path) : relative);

export const snapshotOf = (source: Source, live: string): SqliteSnapshot => {
  const entry = {
    source: source.name,
    path: source.path,
    relative: live === source.path ? "" : live.slice(source.path.length + 1),
  };

  return { ...entry, live, entry: stagedEntry(entry) };
};

export const manifestOf = (plan: BackupPlan): readonly ManifestEntry[] =>
  plan.snapshots.map(({ source, path, relative }) => ({
    source,
    path,
    relative,
  }));

export const entriesFromStage = (
  staged: readonly string[],
  sources: readonly Source[],
  isDirectory: (source: Source) => boolean
): {
  readonly entries: readonly ManifestEntry[];
  readonly unknown: readonly string[];
} => {
  const entries: ManifestEntry[] = [];
  const unknown = new Set<string>();

  for (const file of staged) {
    const [name = "", ...rest] = file.split("/");
    const source = sources.find((candidate) => candidate.name === name);

    if (source === undefined) {
      unknown.add(name);
      continue;
    }

    const relative = rest.join("/");
    entries.push({
      source: name,
      path: source.path,
      relative:
        relative === basename(source.path) && !isDirectory(source)
          ? ""
          : relative,
    });
  }

  return { entries, unknown: [...unknown] };
};

export const sidecars = (live: string): readonly string[] => [
  live,
  `${live}-wal`,
  `${live}-shm`,
  `${live}-journal`,
];

const GENERIC_SIDECARS = [
  "*.sqlite-wal",
  "*.sqlite-shm",
  "*.db-wal",
  "*.db-shm",
] as const;

const globEscape = (path: string) => path.replace(/[\\*?[]/g, "\\$&");

// restic expands $VARS in exclude files, so a literal $ in a path is written as $$.
export const excludeFile = (plan: BackupPlan): string =>
  [
    ...plan.snapshots
      .flatMap((snapshot) => sidecars(snapshot.live))
      .map((path) => globEscape(path).replaceAll("$", "$$$$")),
    ...GENERIC_SIDECARS,
  ]
    .map((line) => `${line}\n`)
    .join("");

export const backupArgs = (
  plan: BackupPlan,
  files: { readonly generated: string; readonly user: string }
): readonly string[] => [
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

export const forgetArgs = (host: string): readonly string[] => [
  "restic",
  "forget",
  "--host",
  host,
  "--tag",
  RESTIC_TAG,
  "--group-by",
  "host,tags",
  ...KEEP,
  "--prune",
];

export const SnapshotId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9]+$/))
);

export const restoreArgs = (
  host: string,
  snapshot: string,
  target: string,
  include?: string
): readonly string[] => [
  "restic",
  "restore",
  snapshot,
  "--host",
  host,
  "--tag",
  RESTIC_TAG,
  "--target",
  target,
  ...(include === undefined ? [] : ["--include", globEscape(include)]),
];

export const BACKUP_TIMEOUT_MS = 120_000;

export const sqliteBackupArgs = (
  live: string,
  dest: string
): readonly string[] => [
  "sqlite3",
  "-cmd",
  ".timeout 30000",
  live,
  `.backup "${dest.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
];

export const vacuumIntoArgs = (
  live: string,
  dest: string
): readonly string[] => [
  "sqlite3",
  "-cmd",
  ".timeout 30000",
  live,
  `vacuum into '${dest.replaceAll("'", "''")}'`,
];

export const quickCheckArgs = (db: string): readonly string[] => [
  "sqlite3",
  db,
  "pragma quick_check",
];
