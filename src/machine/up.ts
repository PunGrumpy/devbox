import { Effect, FileSystem, Option, Schema } from "effect";
import { Command } from "effect/cli";
import { dirname } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { Locations } from "../migrate/locations.ts";
import { Output } from "../output.ts";
import {
  machineConfig,
  type MachineConfig,
  machineFile,
  pathsOf,
  serveArgs,
  upFlags,
} from "./config.ts";
import { Host } from "./host.ts";
import {
  Change,
  type Context,
  type Facts,
  machineInfoPath,
  plan,
  profilePath,
  ServeState,
  Supervisor,
  UNIT,
  unitPath,
} from "./plan.ts";
import { answering } from "./serve.ts";
import { ensureMise } from "./setup.ts";
import { gitEntries, processEnv, settingsFor } from "./settings.ts";

export class UpFailed extends Schema.TaggedError<UpFailed>()("UpFailed", {
  message: Schema.String,
  hint: Schema.optional(Schema.String),
}) {}

const T3Package = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

const systemctl = (scope: "system" | "user", args: ReadonlyArray<string>) =>
  scope === "system" ? ["sudo", "-n", "systemctl", ...args] : ["systemctl", "--user", ...args];

const resolveSupervisor = (config: MachineConfig, sudo: boolean) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const userBus = Effect.map(
      host.run(["systemctl", "--user", "show-environment"]),
      (r) => r.code === 0,
    );
    switch (config.supervisor) {
      case "detached":
        return Supervisor.Detached();
      case "system":
        if (host.systemd && sudo) return Supervisor.Systemd({ scope: "system" });
        return yield* new UpFailed({
          message: "a system unit needs systemd and passwordless sudo",
        });
      case "user":
        if (yield* userBus) return Supervisor.Systemd({ scope: "user" });
        return yield* new UpFailed({ message: "systemctl --user does not answer here" });
      case "auto":
        if (host.systemd && sudo) return Supervisor.Systemd({ scope: "system" });
        if (yield* userBus) return Supervisor.Systemd({ scope: "user" });
        return Supervisor.Detached();
    }
  });

const resolveNpm = (config: MachineConfig) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const fs = yield* FileSystem.FileSystem;
    const out = yield* Output;
    const { mise, npmShim } = pathsOf(config.data);
    const shimReady = fs.exists(npmShim).pipe(Effect.orElseSucceed(() => false));
    if (yield* host.which("npm")) return "npm";
    if (yield* shimReady) return npmShim;
    const env = processEnv(settingsFor(config.data), process.env.PATH ?? "");
    yield* out.log("node: npm is missing, installing Node LTS with mise");
    if ((yield* host.run(["dpkg", "-s", "libatomic1"])).code === 1)
      yield* host.run(["sudo", "-n", "apt-get", "install", "-y", "-qq", "libatomic1"], {
        env: { ...env, DEBIAN_FRONTEND: "noninteractive" },
        inherit: true,
      });
    if (yield* ensureMise(config.data, env))
      yield* host.run([mise, "use", "--global", "--yes", "node@lts"], { env, inherit: true });
    return (yield* shimReady) ? npmShim : "npm";
  });

const gather = (config: MachineConfig, ctx: Context, npm: string) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const fs = yield* FileSystem.FileSystem;
    const read = (path: string) => fs.readFileString(path).pipe(Effect.option);
    const sudo = (yield* host.run(["sudo", "-n", "true"])).code === 0;
    const supervisor = yield* resolveSupervisor(config, sudo);
    const filePaths = [
      machineInfoPath(ctx.etc),
      profilePath(ctx.etc),
      machineFile(ctx.home),
      ...Supervisor.$match(supervisor, {
        Systemd: ({ scope }) => [unitPath(scope, ctx)],
        Detached: () => [],
      }),
    ];
    const files = new Map(
      yield* Effect.forEach(filePaths, (path) => Effect.map(read(path), (c) => [path, c] as const)),
    );
    const git = new Map(
      yield* Effect.forEach(gitEntries(ctx.settings), ({ key }) =>
        Effect.map(host.run(["git", "config", "--global", "--get-all", key]), (r) => {
          const lines = r.code === 0 ? r.stdout.split("\n") : [];
          return [key, lines.slice(0, Math.max(0, lines.length - 1))] as const;
        }),
      ),
    );
    const real = (path: string) => fs.realPath(path).pipe(Effect.orElseSucceed(() => path));
    const dataIsHome = (yield* real(config.data)) === (yield* real(ctx.home));
    const links = new Map(
      yield* Effect.forEach([`${ctx.home}/.agents`, `${ctx.home}/.config/gh`], (path) =>
        Effect.map(fs.readLink(path).pipe(Effect.option), (target) => [path, target] as const),
      ),
    );
    const ghLoginSaved = yield* fs
      .exists(`${config.data}/.config/gh/hosts.yml`)
      .pipe(Effect.orElseSucceed(() => false));
    const installed = yield* read(pathsOf(config.data).t3Package).pipe(
      Effect.map(Option.flatMap((text) => Schema.decodeUnknownOption(T3Package)(text))),
      Effect.map(Option.map((pkg) => pkg.version)),
    );
    const view = yield* host.run([npm, "view", `t3@${config.channel}`, "version"]);
    const latest = Option.filter(
      Option.some(view.stdout.trim()),
      (v) => view.code === 0 && v !== "",
    );
    const serve = yield* Supervisor.$match(supervisor, {
      Systemd: ({ scope }) =>
        Effect.map(
          Effect.all([
            host.run(systemctl(scope, ["is-active", UNIT])),
            host.run(systemctl(scope, ["is-enabled", UNIT])),
          ]),
          ([active, enabled]) =>
            active.stdout.trim() === "active" && enabled.stdout.trim() === "enabled"
              ? ServeState.Running({ pids: [] })
              : ServeState.Stopped(),
        ),
      Detached: () =>
        Effect.map(host.processes, (processes) => {
          const want = [...ctx.self, ...serveArgs(config)];
          const ours = processes.filter(
            (p) =>
              ctx.self.every((part, i) => p.argv[i] === part) &&
              p.argv[ctx.self.length] === "serve" &&
              p.argv.some((arg, i) => arg === config.baseDir && p.argv[i - 1] === "--base-dir"),
          );
          const pids = ours.map((p) => p.pid);
          if (ours.length === 0) return ServeState.Stopped();
          return ours.length === 1 && ours[0]!.argv.join("\0") === want.join("\0")
            ? ServeState.Running({ pids })
            : ServeState.Stale({ pids });
        }),
    });
    const linger = Supervisor.$match(supervisor, {
      Systemd: ({ scope }) =>
        scope === "user"
          ? Effect.map(host.run(["loginctl", "show-user", ctx.user, "--property=Linger"]), (r) =>
              r.code === 0 ? Option.some(r.stdout.trim() === "Linger=yes") : Option.none(),
            )
          : Effect.succeed(Option.none<boolean>()),
      Detached: () => Effect.succeed(Option.none<boolean>()),
    });
    return {
      sudo,
      files,
      git,
      links,
      dataIsHome,
      ghLoginSaved,
      t3: { installed, latest },
      supervisor,
      serve,
      linger: yield* linger,
    } satisfies Facts;
  });

const describe = (change: Change): string =>
  Change.$match(change, {
    Write: ({ path }) => `wrote ${path}`,
    Git: ({ key, values }) =>
      `git config --global ${key} = ${values.map((v) => JSON.stringify(v)).join(", ")}`,
    Link: ({ path, target }) => `linked ${path} -> ${target}`,
    InstallT3: ({ from, to }) => `t3 ${Option.getOrElse(from, () => "none")} -> ${to}`,
    Linger: () => "enabled lingering, so the user unit starts at boot",
    Start: ({ why }) => `started T3 Code, because ${why}`,
  });

const fsFailed = (error: { readonly message: string }) => new UpFailed({ message: error.message });

const apply = (
  change: Change,
  config: MachineConfig,
  ctx: Context,
  supervisor: Supervisor,
  npm: string,
) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const fs = yield* FileSystem.FileSystem;
    const out = yield* Output;
    const must = (argv: ReadonlyArray<string>, options?: { stdin?: string }) =>
      Effect.flatMap(host.run(argv, options), (r) =>
        r.code === 0
          ? Effect.succeed(r)
          : Effect.fail(
              new UpFailed({
                message: `${argv.join(" ")} exited with ${r.code}`,
                hint: r.stderr.trim() || undefined,
              }),
            ),
      );
    yield* Change.$match(change, {
      Write: ({ path, content, privileged }) =>
        privileged
          ? must(["sudo", "-n", "tee", path], { stdin: content })
          : fs
              .makeDirectory(dirname(path), { recursive: true })
              .pipe(Effect.andThen(fs.writeFileString(path, content)), Effect.mapError(fsFailed)),
      Git: ({ key, values }) =>
        Effect.andThen(
          host.run(["git", "config", "--global", "--unset-all", key]),
          Effect.forEach(
            values,
            (value) => must(["git", "config", "--global", "--add", key, value]),
            {
              discard: true,
            },
          ),
        ),
      Link: ({ path, target }) =>
        Effect.gen(function* () {
          const isLink = Option.isSome(yield* fs.readLink(path).pipe(Effect.option));
          if (isLink) {
            yield* fs.remove(path);
          } else if (yield* fs.exists(path)) {
            if (!(yield* fs.exists(target))) {
              yield* fs.makeDirectory(dirname(target), { recursive: true });
              yield* fs.rename(path, target);
            } else if ((yield* fs.readDirectory(path)).length === 0) {
              yield* fs.remove(path, { recursive: true });
            } else {
              return yield* new UpFailed({
                message: `${path} and ${target} both hold files. Merge them into ${target}, remove ${path}, then run devbox up again.`,
              });
            }
          }
          yield* fs.makeDirectory(target, { recursive: true });
          yield* fs.makeDirectory(dirname(path), { recursive: true });
          yield* fs.symlink(target, path);
        }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(fsFailed(error)))),
      InstallT3: ({ to }) =>
        must([npm, "install", "-g", "--prefix", pathsOf(config.data).prefix, `t3@${to}`]),
      Linger: () =>
        host
          .run(["loginctl", "enable-linger", ctx.user])
          .pipe(
            Effect.flatMap((r) =>
              r.code === 0
                ? Effect.void
                : out.warn("loginctl enable-linger failed; T3 starts when you log in"),
            ),
          ),
      Start: ({ stop }) =>
        Supervisor.$match(supervisor, {
          Systemd: ({ scope }) =>
            Effect.all(
              [
                must(systemctl(scope, ["daemon-reload"])),
                must(systemctl(scope, ["enable", UNIT])),
                must(systemctl(scope, ["restart", UNIT])),
              ],
              { discard: true },
            ),
          Detached: () =>
            Effect.andThen(
              Effect.forEach(stop, host.stop, { discard: true }),
              host.spawnDetached([...ctx.self, ...serveArgs(config)], {
                env: {},
                log: `${pathsOf(config.data).logs}/serve.log`,
              }),
            ),
        }),
    });
    yield* out.check(true, describe(change));
  });

export const up = Command.make("up", upFlags, (flags) =>
  Effect.gen(function* () {
    const { home } = yield* Locations;
    const host = yield* Host;
    const out = yield* Output;
    const config = machineConfig(flags, home, host.hostname);
    const ctx: Context = {
      home,
      etc: host.etc,
      user: host.user,
      self: host.self,
      path: host.path,
      settings: settingsFor(config.data),
    };
    yield* out.line(`${out.paint("bold", "devbox")} ${out.paint("dim", packageJson.version)}`);
    yield* out.pairs([
      ["name", config.name],
      ["data", config.data],
      ["port", String(config.port)],
      ["public url", Option.getOrElse(config.publicUrl, () => "none")],
      ["base dir", config.baseDir],
      ["workspace", config.workspace],
      ["channel", config.channel],
    ]);
    const npm = yield* resolveNpm(config);
    const facts = yield* gather(config, ctx, npm);
    if (Option.isNone(facts.t3.installed) && Option.isNone(facts.t3.latest))
      return yield* new UpFailed({
        message: `cannot read t3@${config.channel} from npm, and T3 Code is not installed`,
        hint: "check that npm is on PATH and the registry answers",
      });
    yield* out.log(
      `supervisor: ${Supervisor.$match(facts.supervisor, {
        Systemd: ({ scope }) => `systemd ${scope} unit ${UNIT}`,
        Detached: () => "detached process",
      })}`,
    );
    const { changes, skips } = plan(config, ctx, facts);
    for (const skip of skips) yield* out.note(`skipped ${skip.what}: ${skip.why}`);
    for (const change of changes) yield* apply(change, config, ctx, facts.supervisor, npm);
    const [elapsed, answers] = yield* Effect.timed(answering(config.port, 600));
    if (!answers)
      return yield* new UpFailed({
        message: `T3 Code does not answer on port ${config.port}`,
        hint: Supervisor.$match(facts.supervisor, {
          Systemd: ({ scope }) => `see journalctl ${scope === "user" ? "--user " : ""}-u ${UNIT}`,
          Detached: () => `see ${pathsOf(config.data).logs}/serve.log`,
        }),
      });
    const where = Option.getOrElse(config.publicUrl, () => `http://127.0.0.1:${config.port}`);
    yield* out.success(
      `${changes.length === 0 ? "No changes. " : ""}T3 Code answers on ${where}`,
      elapsed,
    );
  }),
).pipe(
  Command.withDescription(
    "Set up this machine for T3 Code and keep it running. Safe to run again: it changes only what differs.",
  ),
);
