#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Effect, Layer, Runtime } from "effect";
import { CliConfig, CliError, CliOutput, Command, GlobalFlag } from "effect/cli";
import packageJson from "../package.json" with { type: "json" };
import { hintOf } from "./errors.ts";
import { migrateRoot } from "./migrate/command.ts";
import { doctor } from "./migrate/doctor.ts";
import { Locations } from "./migrate/locations.ts";
import { moveThreads } from "./migrate/move-threads.ts";
import { renameRoot } from "./migrate/rename-root.ts";
import { T3Process } from "./migrate/t3-process.ts";
import { Output } from "./output.ts";

export const devbox = Command.make("devbox").pipe(
  Command.withDescription(
    "Set up machines for T3 Code coding agents and maintain T3 Code's local state",
  ),
  Command.withSubcommands([
    migrateRoot.pipe(Command.withSubcommands([doctor, moveThreads, renameRoot])),
  ]),
);

const presenter = Layer.effect(
  CliOutput.Presenter,
  Effect.gen(function* () {
    const out = yield* Output;
    const formatter = CliOutput.defaultFormatter({
      colors: out.stdoutColor,
      globalFlags: "summary",
    });
    return {
      present: (event) => {
        switch (event._tag) {
          case "Help":
            return out.stdout(`${formatter.formatHelpDoc(event.helpDoc)}\n`);
          case "Version":
            return out.stdout(`${event.version}\n`);
          case "InvalidInvocation":
            return Effect.forEach(
              event.errors,
              (error) => out.error(error.message, `run \`${event.commandPath.join(" ")} --help\``),
              { discard: true },
            );
        }
      },
    };
  }),
);

const isHelp = (error: unknown): error is CliError.ShowHelp =>
  CliError.isCliError(error) && error._tag === "ShowHelp";

export const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(devbox, { version: packageJson.version })(args).pipe(
    Effect.as(0),
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (isHelp(error)) return error.errors.length === 0 ? 0 : 2;
        yield* (yield* Output).error(error.message, hintOf(error));
        return Runtime.getErrorExitCode(error);
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* (yield* Output).error(String(Cause.squash(cause)));
        return 1;
      }),
    ),
    Effect.provide(
      Layer.mergeAll(
        presenter,
        CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
      ),
    ),
  );

export const MainLayer = Layer.mergeAll(
  Output.layer,
  Locations.layer,
  T3Process.layer.pipe(Layer.provide(Locations.layer)),
).pipe(Layer.provideMerge(BunServices.layer));

if (import.meta.main) {
  runCli(process.argv.slice(2)).pipe(
    Effect.flatMap((code) =>
      Effect.sync(() => {
        process.exitCode = code;
      }),
    ),
    Effect.provide(MainLayer),
    BunRuntime.runMain,
  );
}
