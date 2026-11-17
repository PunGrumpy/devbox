import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { runCli } from "../../src/cli.ts";
import { Locations } from "../../src/migrate/locations.ts";
import { type RunningServer, T3Process } from "../../src/migrate/t3-process.ts";
import { Output } from "../../src/output.ts";

export type Result = { code: number; out: string; err: string };

export const devbox = async (
  env: Record<string, string>,
  args: ReadonlyArray<string>,
  options: { t3?: RunningServer } = {},
): Promise<Result> => {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const output = Output.make({
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    paint: (_, text) => text,
    stdoutColor: false,
    interactive: false,
    readAnswer: Effect.die("no terminal in tests"),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(Output, output),
    Locations.layer,
    Layer.succeed(T3Process, { running: Effect.succeed(Option.fromUndefinedOr(options.t3)) }),
  ).pipe(
    Layer.provideMerge(BunServices.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
  const code = await Effect.runPromise(runCli(args).pipe(Effect.provide(layer)));
  return { code, out: out.join(""), err: err.join("") };
};

export const migrate = (env: Record<string, string>, ...args: Array<string>) =>
  devbox(env, ["migrate", ...args]);
