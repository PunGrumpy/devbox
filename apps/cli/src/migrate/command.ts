import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import { Output } from "../output.ts";
import { ClaudeFiles } from "./claude-files.ts";
import { ClaudeHomes } from "./claude-homes.ts";
import { resolveTarget } from "./database.ts";
import type { DbTarget } from "./database.ts";

export const migrateRoot = Command.make("migrate").pipe(
  Command.withSharedFlags({
    db: Flag.String("db").pipe(
      Flag.withDescription(
        "database to work on (default ~/.t3/userdata/statev2.sqlite, or under T3_HOME)"
      ),
      Flag.optional
    ),
    claudeHome: Flag.String("claude-home").pipe(
      Flag.withDescription(
        "Claude home for provider instances without a homePath (default ~/.claude)"
      ),
      Flag.optional
    ),
  }),
  Command.withShortDescription("Maintain T3 Code's local state"),
  Command.withDescription(
    "Maintain T3 Code's local state. Writes need --apply, refuse to run while T3 Code is open, and back up the database first."
  )
);

export const writeFlags = {
  apply: Flag.Boolean("apply").pipe(
    Flag.withDescription("write; without it the command is a dry run"),
    Flag.withDefault(false)
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("skip the confirmation prompt"),
    Flag.withDefault(false)
  ),
};

export const inMigrate = <A, E, R>(
  run: (target: DbTarget) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const flags = yield* migrateRoot;
    const out = yield* Output;
    yield* out.line(
      `${out.paint("bold", "devbox")} ${out.paint("dim", packageJson.version)}`
    );
    const target = yield* resolveTarget(flags.db);
    const homes = ClaudeHomes.layer(flags.claudeHome);

    const files =
      target._tag === "Live" ? ClaudeFiles.layer : ClaudeFiles.layerRehearsal;

    return yield* run(target).pipe(
      Effect.provide(Layer.provideMerge(files, homes))
    );
  });
