import { Data, Option, Schema } from "effect";
import { join } from "node:path";

export const INSTRUCTIONS_SOURCE = "PunGrumpy/agents instructions/global.md";

// The repo is private, so this goes through the gh login and not a raw URL.
export const INSTRUCTIONS_FETCH = [
  "gh",
  "api",
  "-H",
  "Accept: application/vnd.github.raw",
  "repos/PunGrumpy/agents/contents/instructions/global.md",
] as const;

const MARKER = `<!-- Written by devbox from ${INSTRUCTIONS_SOURCE}. Edit it there; this file is overwritten. -->`;

export const managedInstructions = (source: string): string => `${MARKER}\n\n${source.trim()}\n`;

const T3Settings = Schema.fromJsonString(
  Schema.Struct({
    providerInstances: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const ClaudeInstance = Schema.Struct({
  driver: Schema.Literal("claudeAgent"),
  config: Schema.optional(Schema.Struct({ homePath: Schema.optional(Schema.String) })),
});

const expandHome = (path: string, home: string) =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

// Every Claude provider instance in T3's settings has its own config home, and each home
// reads its own CLAUDE.md. An instance without a homePath uses $CLAUDE_CONFIG_DIR.
export const claudeHomes = (
  settings: Option.Option<string>,
  home: string,
  data: string,
): ReadonlyArray<string> => {
  const fallback = join(data, ".claude");
  const instances = Option.flatMap(settings, Schema.decodeUnknownOption(T3Settings)).pipe(
    Option.map((decoded) => Object.values(decoded.providerInstances ?? {})),
    Option.getOrElse((): ReadonlyArray<unknown> => []),
  );
  const homes = instances.flatMap((instance) =>
    Option.match(Schema.decodeUnknownOption(ClaudeInstance)(instance), {
      onNone: () => [],
      onSome: ({ config }) => [
        config?.homePath === undefined ? fallback : expandHome(config.homePath, home),
      ],
    }),
  );
  return [...new Set([fallback, ...homes])];
};

export type InstructionsFile = Data.TaggedEnum<{
  Current: {};
  Write: {};
  NotOurs: {};
}>;
export const InstructionsFile = Data.taggedEnum<InstructionsFile>();

export const instructionsFile = (
  current: Option.Option<string>,
  wanted: string,
): InstructionsFile =>
  Option.match(current, {
    onNone: () => InstructionsFile.Write(),
    onSome: (text) =>
      text === wanted
        ? InstructionsFile.Current()
        : text.startsWith(MARKER)
          ? InstructionsFile.Write()
          : InstructionsFile.NotOurs(),
  });
