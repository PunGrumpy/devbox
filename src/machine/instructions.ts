import { Data, Option, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// One file for every agent. Claude Code reads CLAUDE.md, not AGENTS.md, so each Claude
// home gets a link to it and a `git pull` of this repo updates them all.
export const INSTRUCTIONS_FILE = fileURLToPath(
  new URL("../../instructions/AGENTS.md", import.meta.url),
);

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

export type InstructionsLink = Data.TaggedEnum<{
  Linked: {};
  Link: {};
  NotOurs: {};
}>;
export const InstructionsLink = Data.taggedEnum<InstructionsLink>();

export type InstructionsSource = { readonly path: string; readonly text: string };

// A regular file that is a byte-for-byte copy of the source loses nothing as a link.
export const instructionsLink = (
  now: { readonly target: Option.Option<string>; readonly text: Option.Option<string> },
  source: InstructionsSource,
): InstructionsLink =>
  Option.match(now.target, {
    onSome: (target) =>
      target === source.path ? InstructionsLink.Linked() : InstructionsLink.NotOurs(),
    onNone: () =>
      Option.isNone(now.text) || now.text.value === source.text
        ? InstructionsLink.Link()
        : InstructionsLink.NotOurs(),
  });
