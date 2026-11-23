import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { runCli } from "../../src/cli.ts";
import { Host } from "../../src/machine/host.ts";
import { Locations } from "../../src/migrate/locations.ts";
import { type RunningServer, T3Process } from "../../src/migrate/t3-process.ts";
import { Output } from "../../src/output.ts";
import { makeMachine } from "./host.ts";

export type Asked = {
  readonly question: string;
  readonly choices: ReadonlyArray<{ readonly title: string; readonly selected: boolean }>;
};
export type Result = { code: number; out: string; err: string; asked: ReadonlyArray<Asked> };

/** `pick` is a terminal: it lists the titles to tick, and each run of the picker consumes the next list. */
const capture = (pick?: ReadonlyArray<ReadonlyArray<string>>) => {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const asked: Array<Asked> = [];
  const scripted = [...(pick ?? [])];
  const output = Output.make({
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    paint: (_, text) => text,
    stdoutColor: false,
    interactive: pick !== undefined,
    readAnswer: Effect.die("no terminal in tests"),
    pickMany: (question, choices) =>
      Effect.sync(() => {
        asked.push({
          question,
          choices: choices.map(({ title, selected }) => ({ title, selected })),
        });
        const titles = scripted.shift() ?? [];
        return choices.flatMap((choice, i) => (titles.includes(choice.title) ? [i] : []));
      }),
  });
  return { out, err, asked, output };
};

export const devbox = async (
  env: Record<string, string>,
  args: ReadonlyArray<string>,
  options: {
    t3?: RunningServer;
    host?: Host["Service"];
    pick?: ReadonlyArray<ReadonlyArray<string>>;
  } = {},
): Promise<Result> => {
  const { out, err, asked, output } = capture(options.pick);
  const layer = Layer.mergeAll(
    Layer.succeed(Output, output),
    Locations.layer,
    Layer.succeed(Host, options.host ?? makeMachine().host),
    Layer.succeed(T3Process, { running: Effect.succeed(Option.fromUndefinedOr(options.t3)) }),
  ).pipe(
    Layer.provideMerge(BunServices.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
  const code = await Effect.runPromise(runCli(args).pipe(Effect.provide(layer)));
  return { code, out: out.join(""), err: err.join(""), asked };
};

export const migrate = (env: Record<string, string>, ...args: Array<string>) =>
  devbox(env, ["migrate", ...args]);

export const runWith = async <A, E>(
  host: Host["Service"],
  effect: Effect.Effect<A, E, Host | Output | BunServices.BunServices>,
): Promise<{ value: A; err: string }> => {
  const { err, output } = capture();
  const value = await Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(Layer.succeed(Output, output), Layer.succeed(Host, host)).pipe(
          Layer.provideMerge(BunServices.layer),
        ),
      ),
    ),
  );
  return { value, err: err.join("") };
};
