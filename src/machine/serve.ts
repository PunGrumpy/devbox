import { Effect, FileSystem, Option, Schedule, Schema } from "effect";
import { Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Locations } from "../migrate/locations.ts";
import { Output } from "../output.ts";
import { pathsOf, serveConfig, serveFlags } from "./config.ts";
import { Host } from "./host.ts";
import { freePort, proxy } from "./proxy.ts";
import { postStart } from "./setup.ts";
import { processEnv, settingsFor } from "./settings.ts";

export class T3Missing extends Schema.TaggedError<T3Missing>()("T3Missing", {
  path: Schema.String,
}) {
  override get message() {
    return `T3 Code is not installed at ${this.path}`;
  }
  get hint() {
    return "run `devbox up` with the same --data, which installs it";
  }
}

export const answering = (port: number, attempts: number) =>
  Effect.gen(function* () {
    const host = yield* Host;
    return yield* host.answers(port).pipe(
      Effect.flatMap((ok) => (ok ? Effect.succeed(true) : Effect.fail(false))),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: attempts }),
      Effect.orElseSucceed(() => false),
    );
  });

export const serve = Command.make("serve", serveFlags, (flags) =>
  Effect.gen(function* () {
    const { home } = yield* Locations;
    const config = serveConfig(flags, home);
    const host = yield* Host;
    const out = yield* Output;
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { t3 } = pathsOf(config.data);
    if (!(yield* fs.exists(t3).pipe(Effect.orElseSucceed(() => false))))
      return yield* new T3Missing({ path: t3 });

    const sandbox = (yield* host.run(["unshare", "-Ur", "true"])).code === 0;
    const env = {
      ...processEnv(settingsFor(config.data), process.env.PATH ?? ""),
      T3CODE_HOME: config.baseDir,
      // T3 Code runs Chrome with --no-sandbox when this is 0, for hosts that block user namespaces.
      T3CODE_SERVER_BROWSER_SANDBOX: sandbox ? "1" : "0",
    };
    const t3Port = Option.isSome(config.publicUrl) ? yield* freePort : config.port;
    if (Option.isSome(config.publicUrl)) {
      yield* proxy({
        host: "0.0.0.0",
        port: config.port,
        upstream: t3Port,
        publicUrl: config.publicUrl.value,
      });
      yield* out.log(
        `proxy: :${config.port} -> T3 on 127.0.0.1:${t3Port} as ${config.publicUrl.value}`,
      );
    }
    yield* out.log(`t3: browser sandbox ${sandbox ? "on" : "off"}`);

    if (config.setup) {
      yield* answering(t3Port, 600).pipe(
        Effect.flatMap((up) =>
          up ? postStart(config) : out.warn("setup: T3 never answered, skipped"),
        ),
        Effect.forkScoped,
      );
    }

    const t3Serve = ChildProcess.make(
      t3,
      [
        "serve",
        "--host",
        Option.isSome(config.publicUrl) ? "127.0.0.1" : "0.0.0.0",
        "--port",
        String(t3Port),
        "--base-dir",
        config.baseDir,
        config.workspace,
      ],
      {
        env,
        extendEnv: true,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        forceKillAfter: "10 seconds",
      },
    );
    return yield* spawner.exitCode(t3Serve).pipe(
      Effect.flatMap((code) => out.warn(`t3 exited with ${code}, starting it again in 5s`)),
      Effect.catch((error) => out.warn(`t3 did not start: ${error.message}`)),
      Effect.andThen(Effect.sleep("5 seconds")),
      Effect.forever,
    );
  }).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Run T3 Code in the foreground, behind a Host-rewriting proxy when --public-url is set. `devbox up` keeps this running.",
  ),
);
