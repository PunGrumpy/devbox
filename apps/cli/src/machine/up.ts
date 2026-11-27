import path from "node:path";

import { Effect, FileSystem, Option, Schema } from "effect";
import { Command } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import { backupPaths, resticRepositoryOf } from "../backup/config.ts";
import { Locations } from "../migrate/locations.ts";
import { Output } from "../output.ts";
import {
  AgentInstallFailed,
  agentBin,
  agentName,
  chooseAgents,
  installAgent,
  isAgentId,
  loginHint,
  presentAgents,
  readSavedAgents,
} from "./agents.ts";
import {
  machineConfig,
  machineFile,
  pathsOf,
  probeHost,
  serveArgs,
  serveConfig,
  upFlags,
} from "./config.ts";
import type { MachineConfig } from "./config.ts";
import { Host } from "./host.ts";
import {
  BACKUP_SERVICE,
  BACKUP_TIMER,
  HUB_UNIT,
  BackupFact,
  Change,
  machineInfoPath,
  plan,
  profilePath,
  ServeState,
  SPOKE_UNIT,
  Supervisor,
  UNIT,
  t3SettingsPath,
  unitPath,
} from "./plan.ts";
import type { Context, Facts } from "./plan.ts";
import { answering } from "./serve.ts";
import { gitEntries, processEnv, settingsFor } from "./settings.ts";
import { ensureMise } from "./setup.ts";
import { cloudflaredPath, TUNNEL_UNIT, tunnelTokenFile } from "./tunnel.ts";

export class UpFailed extends Schema.TaggedError<UpFailed>()("UpFailed", {
  message: Schema.String,
  hint: Schema.optional(Schema.String),
}) {}

const T3Package = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String })
);

const systemctl = (scope: "system" | "user", args: readonly string[]) =>
  scope === "system"
    ? ["sudo", "-n", "systemctl", ...args]
    : ["systemctl", "--user", ...args];

const resolveSupervisor = (config: MachineConfig, sudo: boolean) =>
  Effect.gen(function* () {
    const host = yield* Host;

    const userBus = Effect.map(
      host.run(["systemctl", "--user", "show-environment"]),
      (r) => r.code === 0
    );

    if (config.supervisor === "detached") {
      return Supervisor.Detached();
    }

    if (config.supervisor === "system") {
      if (host.systemd && sudo) {
        return Supervisor.Systemd({ scope: "system" });
      }

      return yield* new UpFailed({
        message: "a system unit needs systemd and passwordless sudo",
      });
    }

    if (config.supervisor === "user") {
      if (yield* userBus) {
        return Supervisor.Systemd({ scope: "user" });
      }

      return yield* new UpFailed({
        message: "systemctl --user does not answer here",
      });
    }

    if (host.systemd && sudo) {
      return Supervisor.Systemd({ scope: "system" });
    }

    if (yield* userBus) {
      return Supervisor.Systemd({ scope: "user" });
    }

    return Supervisor.Detached();
  });

const resolveNpm = (config: MachineConfig) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const fs = yield* FileSystem.FileSystem;
    const out = yield* Output;
    const { mise, npmShim } = pathsOf(config.data);

    const shimReady = fs
      .exists(npmShim)
      .pipe(Effect.orElseSucceed(() => false));

    if (yield* host.which("npm")) {
      return "npm";
    }

    if (yield* shimReady) {
      return npmShim;
    }

    const env = processEnv(settingsFor(config.data), process.env.PATH ?? "");
    yield* out.log("node: npm is missing, installing Node LTS with mise");

    if ((yield* host.run(["dpkg", "-s", "libatomic1"])).code === 1) {
      yield* host.run(
        ["sudo", "-n", "apt-get", "install", "-y", "-qq", "libatomic1"],
        {
          env: { ...env, DEBIAN_FRONTEND: "noninteractive" },
          inherit: true,
        }
      );
    }

    if (yield* ensureMise(config.data, env)) {
      yield* host.run([mise, "use", "--global", "--yes", "node@lts"], {
        env,
        inherit: true,
      });
    }

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
  saved: Facts["agents"]["saved"]
) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const fs = yield* FileSystem.FileSystem;
    const read = (file: string) => fs.readFileString(file).pipe(Effect.option);
    const sudo = (yield* host.run(["sudo", "-n", "true"])).code === 0;
    const supervisor = yield* resolveSupervisor(config, sudo);

    const filePaths = [
      machineInfoPath(ctx.etc),
      profilePath(ctx.etc),
      machineFile(ctx.home),
      pathsOf(config.data).agents,
      t3SettingsPath(config.baseDir),
      backupPaths(ctx.home).env,
      ...Supervisor.$match(supervisor, {
        Systemd: ({ scope }) => [
          unitPath(scope, ctx),
          unitPath(scope, ctx, BACKUP_SERVICE),
          unitPath(scope, ctx, BACKUP_TIMER),
          unitPath(scope, ctx, HUB_UNIT),
          unitPath(scope, ctx, SPOKE_UNIT),
          unitPath(scope, ctx, TUNNEL_UNIT),
        ],
        Detached: () => [],
      }),
    ];

    const files = new Map(
      yield* Effect.forEach(filePaths, (file) =>
        Effect.map(read(file), (c) => [file, c] as const)
      )
    );

    const git = new Map(
      yield* Effect.forEach(gitEntries(ctx.settings), ({ key }) =>
        Effect.map(
          host.run(["git", "config", "--global", "--get-all", key]),
          (r) => {
            const lines = r.code === 0 ? r.stdout.split("\n") : [];

            return [
              key,
              lines.slice(0, Math.max(0, lines.length - 1)),
            ] as const;
          }
        )
      )
    );

    const real = (file: string) =>
      fs.realPath(file).pipe(Effect.orElseSucceed(() => file));

    const dataIsHome = (yield* real(config.data)) === (yield* real(ctx.home));

    const links = new Map(
      yield* Effect.forEach(
        [`${ctx.home}/.agents`, `${ctx.home}/.config/gh`],
        (file) =>
          Effect.map(
            fs.readLink(file).pipe(Effect.option),
            (target) => [file, target] as const
          )
      )
    );

    const ghLoginSaved = yield* fs
      .exists(`${config.data}/.config/gh/hosts.yml`)
      .pipe(Effect.orElseSucceed(() => false));

    const installed = yield* read(pathsOf(config.data).t3Package).pipe(
      Effect.map(
        Option.flatMap((text) => Schema.decodeUnknownOption(T3Package)(text))
      ),
      Effect.map(Option.map((pkg) => pkg.version))
    );

    const view = yield* host.run(
      [npm, "view", `t3@${config.channel}`, "version"],
      {
        env: processEnv(settingsFor(config.data), process.env.PATH ?? ""),
      }
    );

    const latest = Option.filter(
      Option.some(view.stdout.trim()),
      (v) => view.code === 0 && v !== ""
    );

    const serve = yield* Supervisor.$match(supervisor, {
      Systemd: ({ scope }) =>
        Effect.map(
          Effect.all([
            host.run(systemctl(scope, ["is-active", UNIT])),
            host.run(systemctl(scope, ["is-enabled", UNIT])),
          ]),
          ([active, enabled]) =>
            active.stdout.trim() === "active" &&
            enabled.stdout.trim() === "enabled"
              ? ServeState.Running({ pids: [] })
              : ServeState.Stopped()
        ),
      Detached: () =>
        Effect.map(host.processes, (processes) => {
          const want = [...ctx.self, ...serveArgs(config)];

          const ours = processes.filter(
            (p) =>
              ctx.self.every((part, i) => p.argv[i] === part) &&
              p.argv[ctx.self.length] === "serve" &&
              p.argv.some(
                (arg, i) =>
                  arg === config.baseDir && p.argv[i - 1] === "--base-dir"
              )
          );

          const pids = ours.map((p) => p.pid);

          if (ours.length === 0) {
            return ServeState.Stopped();
          }

          return ours.length === 1 &&
            ours[0]?.argv.join("\0") === want.join("\0")
            ? ServeState.Running({ pids })
            : ServeState.Stale({ pids });
        }),
    });

    const linger = Supervisor.$match(supervisor, {
      Systemd: ({ scope }) =>
        scope === "user"
          ? Effect.map(
              host.run([
                "loginctl",
                "show-user",
                ctx.user,
                "--property=Linger",
              ]),
              (r) =>
                r.code === 0
                  ? Option.some(r.stdout.trim() === "Linger=yes")
                  : Option.none()
            )
          : Effect.succeed(Option.none<boolean>()),
      Detached: () => Effect.succeed(Option.none<boolean>()),
    });

    const envPath = backupPaths(ctx.home).env;

    const backup = yield* Option.match(
      Option.flatten(Option.fromUndefinedOr(files.get(envPath))),
      {
        onNone: () => Effect.succeed(backupOff(envPath)),
        onSome: (text) =>
          resticRepositoryOf(text) === undefined
            ? Effect.succeed(backupOff(envPath))
            : Effect.gen(function* () {
                const missing = yield* Effect.filter(
                  ["restic", "sqlite3"],
                  (name) => Effect.map(host.which(name), (found) => !found)
                );

                const timer = yield* Supervisor.$match(supervisor, {
                  Systemd: ({ scope }) =>
                    Effect.map(
                      Effect.all([
                        host.run(systemctl(scope, ["is-active", BACKUP_TIMER])),
                        host.run(
                          systemctl(scope, ["is-enabled", BACKUP_TIMER])
                        ),
                      ]),
                      ([active, enabled]) => ({
                        active: active.stdout.trim() === "active",
                        enabled: enabled.stdout.trim() === "enabled",
                      })
                    ),
                  Detached: () =>
                    Effect.succeed({ active: false, enabled: false }),
                });

                return BackupFact.On({
                  missing,
                  timer,
                  apt: yield* host.which("apt-get"),
                });
              }),
      }
    );

    const script =
      ctx.self.length === 2
        ? Option.fromUndefinedOr(ctx.self[1])
        : Option.none<string>();

    const checkout = Option.map(script, (file) =>
      path.resolve(path.dirname(file), "../../..")
    );

    const running = (unit: string) =>
      Supervisor.$match(supervisor, {
        Systemd: ({ scope }) =>
          Effect.map(
            Effect.all([
              host.run(systemctl(scope, ["is-active", unit])),
              host.run(systemctl(scope, ["is-enabled", unit])),
            ]),
            ([active, enabled]) =>
              active.stdout.trim() === "active" &&
              enabled.stdout.trim() === "enabled"
          ),
        Detached: () => Effect.succeed(false),
      });

    const checkHubRunning = running(HUB_UNIT);

    const checkHubBuilt = Option.match(checkout, {
      onNone: () => Effect.succeed(false),
      onSome: (dir) =>
        Effect.map(
          Effect.all([read(hubStamp(dir)), hubSourceTree(dir)]),
          ([stamp, tree]) =>
            Option.isSome(stamp) &&
            (Option.isNone(tree) || stamp.value.trim() === tree.value)
        ),
    });

    const hub = config.hub
      ? {
          running: yield* checkHubRunning,
          built: yield* checkHubBuilt,
          checkout,
        }
      : { running: false, built: false, checkout };

    const lingering = yield* linger;

    const spoke = {
      running: config.spoke ? yield* running(SPOKE_UNIT) : false,
    };

    const tunnel = config.tunnel
      ? {
          running: yield* running(TUNNEL_UNIT),
          cloudflared: yield* fs
            .exists(cloudflaredPath(ctx.home))
            .pipe(Effect.orElseSucceed(() => false)),
        }
      : { running: false, cloudflared: false };

    const agents = { saved, present: yield* presentAgents(config.data) };

    return {
      sudo,
      files,
      git,
      links,
      dataIsHome,
      ghLoginSaved,
      supervisor,
      serve,
      backup,
      hub,
      spoke,
      tunnel,
      agents,
      t3: { installed, latest },
      linger: lingering,
    } satisfies Facts;
  });

const HUB_DIR = path.join("apps", "hub");

const hubStamp = (checkout: string) =>
  path.join(checkout, HUB_DIR, "out", ".built");

const hubSourceTree = (checkout: string) =>
  Effect.gen(function* () {
    const host = yield* Host;

    const tree = yield* host.run([
      "git",
      "-C",
      checkout,
      "rev-parse",
      "HEAD:apps/hub",
    ]);

    return tree.code === 0
      ? Option.some(tree.stdout.trim())
      : Option.none<string>();
  });

const describe = (change: Change) =>
  Change.$match(change, {
    Write: ({ path: file }) => `wrote ${file}`,
    Git: ({ key, values }) =>
      `git config --global ${key} = ${values.map((v) => JSON.stringify(v)).join(", ")}`,
    Link: ({ path: file, target }) => `linked ${file} -> ${target}`,
    InstallT3: ({ from, to }) =>
      `t3 ${Option.getOrElse(from, () => "none")} -> ${to}`,
    InstallAgent: ({ id }) =>
      `installed ${agentName(id)}. Log in once: ${loginHint(id)}`,
    Linger: () => "enabled lingering, so the user unit starts at boot",
    InstallTools: ({ packages }) =>
      `installed ${packages.join(" and ")} with apt`,
    EnableTimer: () => `enabled ${BACKUP_TIMER}, daily at 03:30 Asia/Bangkok`,
    Start: ({ why }) => `started T3 Code, because ${why}`,
    BuildHub: () => "built the hub page",
    EnableHub: ({ address }) => `enabled ${HUB_UNIT} on ${address}`,
    RemoveHub: () => `removed ${HUB_UNIT}, because --hub is off`,
    EnableSpoke: ({ address }) => `enabled ${SPOKE_UNIT} on ${address}`,
    RemoveSpoke: () => `removed ${SPOKE_UNIT}, because --spoke is off`,
    InstallCloudflared: ({ path: file }) =>
      `installed cloudflared at ${file} with mise`,
    EnableTunnel: () => `enabled ${TUNNEL_UNIT}`,
    RemoveTunnel: () => `removed ${TUNNEL_UNIT}, because --tunnel is off`,
  });

const fsFailed = (error: { readonly message: string }) =>
  new UpFailed({ message: error.message });

const apply = (
  change: Change,
  config: MachineConfig,
  ctx: Context,
  supervisor: Supervisor,
  npm: string
) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const fs = yield* FileSystem.FileSystem;
    const out = yield* Output;

    const must = (
      argv: readonly string[],
      options?: { stdin?: string; env?: Record<string, string> }
    ) =>
      Effect.flatMap(host.run(argv, options), (r) =>
        r.code === 0
          ? Effect.succeed(r)
          : Effect.fail(
              new UpFailed({
                message: `${argv.join(" ")} exited with ${r.code}`,
                hint: r.stderr.trim() || undefined,
              })
            )
      );

    const enable = (unit: string) =>
      Supervisor.$match(supervisor, {
        Systemd: ({ scope }) =>
          Effect.all(
            [
              must(systemctl(scope, ["daemon-reload"])),
              must(systemctl(scope, ["enable", unit])),
              must(systemctl(scope, ["restart", unit])),
            ],
            { discard: true }
          ),
        Detached: () => Effect.void,
      });

    const remove = (unit: string, file: string, privileged: boolean) =>
      Supervisor.$match(supervisor, {
        Systemd: ({ scope }) =>
          Effect.gen(function* () {
            yield* host.run(systemctl(scope, ["disable", "--now", unit]));
            yield* privileged
              ? must(["sudo", "-n", "rm", "-f", file])
              : fs.remove(file).pipe(Effect.ignore);
            yield* must(systemctl(scope, ["daemon-reload"]));
          }),
        Detached: () => Effect.void,
      });

    yield* Change.$match(change, {
      Write: ({ path: file, content, privileged, mode }) =>
        privileged
          ? must(["sudo", "-n", "tee", file], { stdin: content })
          : fs
              .makeDirectory(path.dirname(file), { recursive: true })
              .pipe(
                Effect.andThen(
                  fs.writeFileString(
                    file,
                    content,
                    Option.isSome(mode) ? { mode: mode.value } : {}
                  )
                ),
                Effect.mapError(fsFailed)
              ),
      Git: ({ key, values }) =>
        Effect.andThen(
          host.run(["git", "config", "--global", "--unset-all", key]),
          Effect.forEach(
            values,
            (value) => must(["git", "config", "--global", "--add", key, value]),
            {
              discard: true,
            }
          )
        ),
      Link: ({ path: file, target }) =>
        Effect.gen(function* () {
          const empty = (dir: string) =>
            fs.readDirectory(dir).pipe(
              Effect.map((entries) => entries.length === 0),
              Effect.orElseSucceed(() => false)
            );

          const move = (from: string, to: string) =>
            fs
              .rename(from, to)
              .pipe(
                Effect.catchTag("PlatformError", () =>
                  fs
                    .copy(from, to)
                    .pipe(Effect.andThen(fs.remove(from, { recursive: true })))
                )
              );

          const isLink = Option.isSome(
            yield* fs.readLink(file).pipe(Effect.option)
          );

          if (isLink) {
            yield* fs.remove(file);
          } else if (yield* fs.exists(file)) {
            if (!(yield* fs.exists(target)) || (yield* empty(target))) {
              yield* fs.remove(target, { recursive: true, force: true });
              yield* fs.makeDirectory(path.dirname(target), {
                recursive: true,
              });
              yield* move(file, target);
            } else if (yield* empty(file)) {
              yield* fs.remove(file, { recursive: true });
            } else {
              const aside = `${file}.devbox-${Date.now()}`;
              yield* fs.rename(file, aside);
              yield* out.warn(
                `${file} and ${target} both held files; kept ${target} and moved the other to ${aside}`
              );
            }
          }

          yield* fs.makeDirectory(target, { recursive: true });
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.symlink(target, file);
        }).pipe(
          Effect.catchTag("PlatformError", (error) =>
            Effect.fail(fsFailed(error))
          )
        ),
      InstallT3: ({ to }) =>
        must(
          [
            npm,
            "install",
            "-g",
            "--prefix",
            pathsOf(config.data).prefix,
            `t3@${to}`,
          ],
          {
            env: processEnv(settingsFor(config.data), process.env.PATH ?? ""),
          }
        ),
      InstallAgent: ({ id }) =>
        installAgent(id, config.data, npm).pipe(
          Effect.flatMap((ran) =>
            Effect.flatMap(
              fs
                .exists(agentBin(config.data, id))
                .pipe(Effect.orElseSucceed(() => false)),
              (installed) =>
                installed
                  ? Effect.void
                  : Effect.fail(
                      new AgentInstallFailed({
                        id,
                        code: ran.code,
                        detail: ran.stderr.trim().split("\n").at(-1) ?? "",
                      })
                    )
            )
          )
        ),
      Linger: () =>
        host
          .run(["loginctl", "enable-linger", ctx.user])
          .pipe(
            Effect.flatMap((r) =>
              r.code === 0
                ? Effect.void
                : out.warn(
                    "loginctl enable-linger failed; T3 starts when you log in"
                  )
            )
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
          ])
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
              { discard: true }
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
              { discard: true }
            ),
          Detached: () =>
            Effect.andThen(
              Effect.forEach(stop, host.stop, { discard: true }),
              host.spawnDetached([...ctx.self, ...serveArgs(config)], {
                env: {},
                log: `${pathsOf(config.data).logs}/serve.log`,
              })
            ),
        }),
      EnableHub: () => enable(HUB_UNIT),
      RemoveHub: ({ path: file, privileged }) =>
        remove(HUB_UNIT, file, privileged),
      EnableSpoke: () => enable(SPOKE_UNIT),
      RemoveSpoke: ({ path: file, privileged }) =>
        remove(SPOKE_UNIT, file, privileged),
      InstallCloudflared: ({ path: file }) =>
        Effect.gen(function* () {
          const env = processEnv(
            settingsFor(config.data),
            process.env.PATH ?? ""
          );

          if (!(yield* ensureMise(config.data, env))) {
            return yield* new UpFailed({
              message: "cannot download mise to install cloudflared",
            });
          }

          const { mise } = pathsOf(config.data);
          yield* must([mise, "use", "--global", "--yes", "cloudflared"], {
            env,
          });
          const which = yield* must([mise, "which", "cloudflared"], { env });
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.remove(file, { force: true });
          yield* fs.symlink(which.stdout.trim(), file);
        }).pipe(
          Effect.catchTag("PlatformError", (error) =>
            Effect.fail(fsFailed(error))
          )
        ),
      EnableTunnel: () => enable(TUNNEL_UNIT),
      RemoveTunnel: ({ path: file, privileged }) =>
        remove(TUNNEL_UNIT, file, privileged),
      BuildHub: ({ checkout }) =>
        Effect.gen(function* () {
          const cwd = path.join(checkout, HUB_DIR);
          const bun = ctx.self[0] ?? "bun";

          for (const { argv, at } of [
            {
              argv: [bun, "install", "--frozen-lockfile", "--filter", "hub"],
              at: checkout,
            },
            { argv: [bun, "run", "build"], at: cwd },
          ]) {
            const ran = yield* host.run(argv, { cwd: at, inherit: true });

            if (ran.code !== 0) {
              return yield* new UpFailed({
                message: `the hub page did not build: ${argv.slice(1).join(" ")} exited with ${ran.code}`,
                hint: `the hub still serves /api/machines. Run \`bun run build\` in ${cwd} to see why`,
              });
            }
          }

          const tree = yield* hubSourceTree(checkout);
          yield* fs
            .writeFileString(
              hubStamp(checkout),
              `${Option.getOrElse(tree, () => "unknown")}\n`
            )
            .pipe(Effect.ignore);
        }),
    });
    yield* out.check(true, describe(change));
  });

export const up = Command.make("up", upFlags, (flags) =>
  Effect.gen(function* () {
    const { home } = yield* Locations;
    const host = yield* Host;
    const out = yield* Output;
    const fs = yield* FileSystem.FileSystem;
    const served = yield* serveConfig(flags, home);
    const saved = yield* readSavedAgents(served.data);
    const agents = yield* chooseAgents(flags.agents, saved);
    const config = yield* machineConfig(flags, home, host.hostname, agents);

    const ctx: Context = {
      home,
      etc: host.etc,
      user: host.user,
      self: host.self,
      path: host.path,
      settings: settingsFor(config.data),
    };

    yield* out.line(
      `${out.paint("bold", "devbox")} ${out.paint("dim", packageJson.version)}`
    );
    yield* out.pairs([
      ["name", config.name],
      ["data", config.data],
      ["port", String(config.port)],
      ["host", config.host],
      ["public url", Option.getOrElse(config.publicUrl, () => "none")],
      ["base dir", config.baseDir],
      ["workspace", config.workspace],
      ["channel", config.channel],
      ["agents", `${agents.ids.join(", ") || "none"} (${agents.from})`],
    ]);

    if (agents.from === "default") {
      const dataFlag = config.data === home ? "" : ` --data ${config.data}`;

      yield* out.note(
        `no terminal to ask which agent CLIs to install, so using the defaults. Run \`devbox up${dataFlag} --agents pick\` on a terminal to choose`
      );
    }

    const token = tunnelTokenFile(home);

    if (
      config.tunnel &&
      !(yield* fs.exists(token).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return yield* new UpFailed({
        message: `--tunnel needs the tunnel's token in ${token}, and there is none`,
        hint: "the hub saves it when it publishes this machine. Without a hub, see Reach T3 without Tailscale in the README",
      });
    }

    const npm = yield* resolveNpm(config);
    const facts = yield* gather(config, ctx, npm, saved);

    if (Option.isNone(facts.t3.installed) && Option.isNone(facts.t3.latest)) {
      return yield* new UpFailed({
        message: `cannot read t3@${config.channel} from npm, and T3 Code is not installed`,
        hint: "check that npm is on PATH and the registry answers",
      });
    }

    yield* out.log(
      `supervisor: ${Supervisor.$match(facts.supervisor, {
        Systemd: ({ scope }) => `systemd ${scope} unit ${UNIT}`,
        Detached: () => "detached process",
      })}`
    );
    const { changes, skips } = plan(config, ctx, facts);

    for (const skip of skips) {
      yield* out.note(`skipped ${skip.what}: ${skip.why}`);
    }

    for (const change of changes) {
      yield* apply(change, config, ctx, facts.supervisor, npm).pipe(
        Effect.catchTag("AgentInstallFailed", (error) =>
          out.check(
            false,
            `${isAgentId(error.id) ? agentName(error.id) : error.id} did not install. The next devbox up tries again`,
            error.detail
          )
        )
      );
    }

    const [elapsed, answers] = yield* Effect.timed(
      answering(config.host, config.port, 600)
    );

    if (!answers) {
      return yield* new UpFailed({
        message: `T3 Code does not answer on port ${config.port}`,
        hint: Supervisor.$match(facts.supervisor, {
          Systemd: ({ scope }) =>
            `see journalctl ${scope === "user" ? "--user " : ""}-u ${UNIT}`,
          Detached: () => `see ${pathsOf(config.data).logs}/serve.log`,
        }),
      });
    }

    const where = Option.getOrElse(
      config.publicUrl,
      () => `http://${probeHost(config.host)}:${config.port}`
    );

    yield* out.success(
      `${changes.length === 0 ? "No changes. " : ""}T3 Code answers on ${where}`,
      elapsed
    );
  })
).pipe(
  Command.withDescription(
    "Set up this machine for T3 Code and keep it running. Safe to run again: it changes only what differs."
  )
);
