import { join } from "node:path";

import { Effect, FileSystem, Result, Schema } from "effect";

import { AbsolutePath, absolutePath } from "../migrate/paths.ts";

export const backupPaths = (home: string) => {
  const dir = join(home, ".config", "devbox", "backup");
  const state = join(home, ".local", "state", "devbox", "backup");

  return {
    dir,
    sources: join(dir, "sources"),
    excludes: join(dir, "excludes"),
    env: join(dir, "env"),
    state: absolutePath(state),
    stage: absolutePath(join(state, "sqlite")),
    generatedExcludes: join(state, "sqlite-excludes"),
    lock: join(state, "lock"),
  };
};

export const DEFAULT_SOURCES = `# <name> <path>. One line per agent. ~ is $HOME, $DATA is devbox up --data. Missing paths are skipped.
claude       $DATA/.claude
claude-json  ~/.claude.json
t3           $DATA/.t3/userdata
codex        ~/.codex
gemini       ~/.gemini
grok         ~/.grok
cursor       ~/.cursor
opencode     ~/.local/share/opencode
opencode-cfg ~/.config/opencode
agents       $DATA/.agents
`;

export const DEFAULT_EXCLUDES = `$DEVBOX_DATA/.t3/userdata/logs
$DEVBOX_DATA/.t3/userdata/server-browser
$DEVBOX_DATA/.t3/userdata/antigravity-tmp
$DEVBOX_DATA/.claude/plugins/.trash
$DEVBOX_DATA/.claude/plugins/cache
$HOME/.codex/logs_*.sqlite*
node_modules
.cache
`;

export const envTemplate = (home: string) => `RESTIC_REPOSITORY=
RESTIC_PASSWORD_FILE=${join(home, ".config", "devbox", "backup", "restic-password")}
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_DEFAULT_REGION=auto
`;

const EnvName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))
);

export interface ParsedEnv {
  readonly values: Readonly<Record<string, string>>;
  readonly invalid: readonly number[];
}

const unquote = (value: string) =>
  value.length >= 2 &&
  (value.startsWith('"') || value.startsWith("'")) &&
  value.endsWith(value[0]!)
    ? value.slice(1, -1)
    : value;

export const parseEnv = (text: string): ParsedEnv => {
  const values: Record<string, string> = {};
  const invalid: number[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();

    if (line === "" || line.startsWith("#")) {
      return;
    }

    const at = line.indexOf("=");
    const name = at < 1 ? undefined : line.slice(0, at).trim();

    if (
      name === undefined ||
      Result.isFailure(Schema.decodeUnknownResult(EnvName)(name))
    ) {
      return void invalid.push(index + 1);
    }

    values[name] = unquote(line.slice(at + 1).trim());
  });

  return { values, invalid };
};

export const resticRepositoryOf = (text: string): string | undefined => {
  const { values, invalid } = parseEnv(text);
  const repository = values.RESTIC_REPOSITORY;

  return invalid.length === 0 && repository !== undefined && repository !== ""
    ? repository
    : undefined;
};

export const ensureConfig = (home: AbsolutePath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = backupPaths(home);
    yield* fs.makeDirectory(paths.dir, { recursive: true });

    const create = (path: string, content: string, mode: number) =>
      fs.writeFileString(path, content, { flag: "wx", mode }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false)
        )
      );

    const created = yield* Effect.forEach(
      [
        [paths.sources, DEFAULT_SOURCES, 0o644],
        [paths.excludes, DEFAULT_EXCLUDES, 0o644],
        [paths.env, envTemplate(home), 0o600],
      ] as const,
      ([path, content, mode]) =>
        Effect.map(create(path, content, mode), (made) => (made ? [path] : []))
    );

    return created.flat();
  });
