import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Locations } from "./locations.ts";

export type RunningServer = { readonly pid: number; readonly version: string | null };

export class T3Running extends Schema.TaggedError<T3Running>()("T3Running", {
  pid: Schema.Number,
}) {
  override get message() {
    return `T3 Code is running (pid ${this.pid})`;
  }
  get hint() {
    return "quit T3 Code first; it holds the database open with a WAL";
  }
}

const RuntimeFile = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.optional(Schema.Number),
    serverVersion: Schema.optional(Schema.String),
  }),
);

const PROCESS_PATTERNS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "T3 Code.*/Contents/MacOS/T3 Code",
  linux: "(^|/)t3 (serve|--bootstrap-fd)",
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export class T3Process extends Context.Service<
  T3Process,
  { readonly running: Effect.Effect<Option.Option<RunningServer>> }
>()("devbox/migrate/T3Process") {
  static readonly layer = Layer.effect(
    T3Process,
    Effect.gen(function* () {
      const { runtimeFile } = yield* Locations;
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fromRuntimeFile = fs.readFileString(runtimeFile).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RuntimeFile)),
        Effect.map(({ pid, serverVersion }) =>
          pid !== undefined && pidAlive(pid)
            ? Option.some({ pid, version: serverVersion ?? null })
            : Option.none(),
        ),
        Effect.orElseSucceed(Option.none<RunningServer>),
      );
      const pattern = PROCESS_PATTERNS[process.platform];
      const fromProcessScan =
        pattern === undefined
          ? Effect.succeed(Option.none<RunningServer>())
          : spawner.lines(ChildProcess.make("pgrep", ["-f", pattern])).pipe(
              Effect.map((lines) => {
                const pid = Number.parseInt(lines[0] ?? "", 10);
                return Number.isFinite(pid) ? Option.some({ pid, version: null }) : Option.none();
              }),
              Effect.orElseSucceed(Option.none<RunningServer>),
            );
      return {
        running: fromRuntimeFile.pipe(
          Effect.flatMap((found) =>
            Option.isSome(found) ? Effect.succeed(found) : fromProcessScan,
          ),
        ),
      };
    }),
  );
}

export const assertT3Closed = Effect.gen(function* () {
  const running = yield* (yield* T3Process).running;
  if (Option.isSome(running)) return yield* new T3Running({ pid: running.value.pid });
});
