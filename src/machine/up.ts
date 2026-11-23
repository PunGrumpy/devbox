import { Effect, FileSystem, Option, Schema } from "effect";
import { Command } from "effect/cli";
import { dirname } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { backupPaths, resticRepositoryOf } from "../backup/config.ts";
import { Locations } from "../migrate/locations.ts";
import { Output } from "../output.ts";
import {
  machineConfig,
  type MachineConfig,
  machineFile,
  pathsOf,
  serveArgs,
  serveConfig,
  upFlags,
} from "./config.ts";
import {
  type AgentId,
  AgentInstallFailed,
  agentName,
  chooseAgents,
  installAgent,
  loginHint,
  presentAgents,
  readSavedAgents,
} from "./agents.ts";
import { Host } from "./host.ts";
import {
  BACKUP_SERVICE,
  BACKUP_TIMER,
  BackupFact,
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

const backupOff = (envPath: string) =>
  BackupFact.Off({
    why: `off. Run \`devbox backup sources\` to create ${envPath}, set RESTIC_REPOSITORY in it, then run \`devbox up\` again`,
  });

const gather = (
  config: MachineConfig,
  ctx: Context,
  npm: string,
  saved: Facts["agents"]["saved"],
) =>
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
      pathsOf(config.data).agents,
      backupPaths(ctx.home).env,
      ...Supervisor.$match(supervisor, {
        Systemd: ({ scope }) => [
          unitPath(scope, ctx),
          unitPath(scope, ctx, BACKUP_SERVICE),
          unitPath(scope, ctx, BACKUP_TIMER),
        ],
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
    const view = yield* host.run([npm, "view", `t3@${config.channel}`, "version"], {
      env: processEnv(settingsFor(config.data), process.env.PATH ?? ""),
    });
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
    const envPath = backupPaths(ctx.home).env;
    const backup = yield* Option.match(Option.flatten(Option.fromUndefinedOr(files.get(envPath))), {
      onNone: () => Effect.succeed(backupOff(envPath)),
      onSome: (text) =>
        resticRepositoryOf(text) === undefined
          ? Effect.succeed(backupOff(envPath))
          : Effect.gen(function* () {
              const missing = yield* Effect.filter(["restic", "sqlite3"], (name) =>
                Effect.map(host.which(name), (found) => !found),
              );
              const timer = yield* Supervisor.$match(supervisor, {
                Systemd: ({ scope }) =>
                  Effect.map(
                    Effect.all([
                      host.run(systemctl(scope, ["is-active", BACKUP_TIMER])),
                      host.run(systemctl(scope, ["is-enabled", BACKUP_TIMER])),
                    ]),
                    ([active, enabled]) => ({
                      active: active.stdout.trim() === "active",
                      enabled: enabled.stdout.trim() === "enabled",
                    }),
                  ),
                Detached: () => Effect.succeed({ active: false, enabled: false }),
              });
              return BackupFact.On({ missing, apt: yield* host.which("apt-get"), timer });
            }),
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
      backup,
      agents: { saved, present: yield* presentAgents(config.data) },
    } satisfies Facts;
  });

const describe = (change: Change): string =>
  Change.$match(change, {
    Write: ({ path }) => `wrote ${path}`,
    Git: ({ key, values }) =>
      `git config --global ${key} = ${values.map((v) => JSON.stringify(v)).join(", ")}`,
    Link: ({ path, target }) => `linked ${path} -> ${target}`,
    InstallT3: ({ from, to }) => `t3 ${Option.getOrElse(from, () => "none")} -> ${to}`,
    InstallAgent: ({ id }) => `installed ${agentName(id)}. Log in once: ${loginHint(id)}`,
    Linger: () => "enabled lingering, so the user unit starts at boot",
    InstallTools: ({ packages }) => `installed ${packages.join(" and ")} with apt`,
    EnableTimer: () => `enabled ${BACKUP_TIMER}, daily at 03:30 Asia/Bangkok`,
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
    const must = (
      argv: ReadonlyArray<string>,
      options?: { stdin?: string; env?: Record<string, string> },
    ) =>
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
          const empty = (dir: string) =>
            fs.readDirectory(dir).pipe(
              Effect.map((entries) => entries.length === 0),
              Effect.orElseSucceed(() => false),
            );
          const move = (from: string, to: string) =>
            fs
              .rename(from, to)
              .pipe(
                Effect.catchTag("PlatformError", () =>
                  fs.copy(from, to).pipe(Effect.andThen(fs.remove(from, { recursive: true }))),
                ),
              );
          const isLink = Option.isSome(yield* fs.readLink(path).pipe(Effect.option));
          if (isLink) {
            yield* fs.remove(path);
          } else if (yield* fs.exists(path)) {
            if (!(yield* fs.exists(target)) || (yield* empty(target))) {
              yield* fs.remove(target, { recursive: true, force: true });
              yield* fs.makeDirectory(dirname(target), { recursive: true });
              yield* move(path, target);
            } else if (yield* empty(path)) {
              yield* fs.remove(path, { recursive: true });
            } else {
              const aside = `${path}.devbox-${Date.now()}`;
              yield* fs.rename(path, aside);
              yield* out.warn(
                `${path} and ${target} both held files; kept ${target} and moved the other to ${aside}`,
              );
            }
          }
          yield* fs.makeDirectory(target, { recursive: true });
          yield* fs.makeDirectory(dirname(path), { recursive: true });
          yield* fs.symlink(target, path);
        }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(fsFailed(error)))),
      InstallT3: ({ to }) =>
        must([npm, "install", "-g", "--prefix", pathsOf(config.data).prefix, `t3@${to}`], {
          env: processEnv(settingsFor(config.data), process.env.PATH ?? ""),
        }),
      InstallAgent: ({ id }) =>
        installAgent(id, config.data, npm).pipe(
          Effect.flatMap((ran) =>
            ran.code === 0
              ? Effect.void
              : Effect.fail(
                  new AgentInstallFailed({
                    id,
                    code: ran.code,
                    detail: ran.stderr.trim().split("\n").at(-1) ?? "",
                  }),
                ),
          ),
        ),
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
      InstallTools: ({ packages }) =>
        Effect.andThen(
          must(["sudo", "-n", "apt-get", "update", "-qq"]),
          must([
            "sudo",
            "-n",
            "env",
            "DEBIAN_FRONTEND=noninteractive",
            "apt-get",
            "install",
            "-y",
            "-qq",
            "--no-install-recommends",
            ...packages,
          ]),
        ),
      EnableTimer: () =>
        Supervisor.$match(supervisor, {
          Systemd: ({ scope }) =>
            Effect.all(
              [
                must(systemctl(scope, ["daemon-reload"])),
                must(systemctl(scope, ["enable", BACKUP_TIMER])),
                must(systemctl(scope, ["restart", BACKUP_TIMER])),
              ],
              { discard: true },
            ),
          Detached: () => Effect.void,
        }),
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
    const saved = yield* readSavedAgents(serveConfig(flags, home).data);
    const agents = yield* chooseAgents(flags.agents, saved);
    const config = machineConfig(flags, home, host.hostname, agents);
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
      ["agents", `${agents.ids.join(", ") || "none"} (${agents.from})`],
    ]);
    if (agents.from === "default")
      yield* out.note(
        `no terminal to ask which agent CLIs to install, so using the defaults. Run \`devbox up${config.data === home ? "" : ` --data ${config.data}`} --agents pick\` on a terminal to choose`,
      );
    const npm = yield* resolveNpm(config);
    const facts = yield* gather(config, ctx, npm, saved);
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
    for (const change of changes)
      yield* apply(change, config, ctx, facts.supervisor, npm).pipe(
        Effect.catchTag("AgentInstallFailed", (error) =>
          out.check(
            false,
            `${agentName(error.id as AgentId)} did not install. The next devbox up tries again`,
            error.detail,
          ),
        ),
      );
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
