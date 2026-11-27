import path from "node:path";

import { Effect, FileSystem, Result, Schema } from "effect";

import type { AbsolutePath } from "../migrate/paths.ts";
import { absolutePath } from "../migrate/paths.ts";

export const backupPaths = (home: string) => {
  const dir = path.join(home, ".config", "devbox", "backup");
  const state = path.join(home, ".local", "state", "devbox", "backup");

  return {
    dir,
    sources: path.join(dir, "sources"),
    excludes: path.join(dir, "excludes"),
    env: path.join(dir, "env"),
    state: absolutePath(state),
    stage: absolutePath(path.join(state, "sqlite")),
    generatedExcludes: path.join(state, "sqlite-excludes"),
    lock: path.join(state, "lock"),
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
RESTIC_PASSWORD_FILE=${path.join(home, ".config", "devbox", "backup", "restic-password")}
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_DEFAULT_REGION=auto
`;

const EnvName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z_]\w*$/u))
);

export interface ParsedEnv {
  readonly values: Readonly<Record<string, string>>;
  readonly invalid: readonly number[];
}

const unquote = (value: string) => {
  const quote = value.at(0);

  const quoted =
    value.length >= 2 &&
    (quote === '"' || quote === "'") &&
    value.endsWith(quote);

  return quoted ? value.slice(1, -1) : value;
};

export const parseEnv = (text: string) => {
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
      invalid.push(index + 1);

      return;
    }

    values[name] = unquote(line.slice(at + 1).trim());
  });

  return { values, invalid } satisfies ParsedEnv;
};

export const resticRepositoryOf = (text: string) => {
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

    const create = (file: string, content: string, mode: number) =>
      fs.writeFileString(file, content, { flag: "wx", mode }).pipe(
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
      ([file, content, mode]) =>
        Effect.map(create(file, content, mode), (made) => (made ? [file] : []))
    );

    return created.flat();
  });
