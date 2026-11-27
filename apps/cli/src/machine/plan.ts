import { join } from "node:path";

import { Data, Option, Schema } from "effect";

import { SPOKE_PORT } from "../spoke/vitals.ts";
import {
  type AgentId,
  type AgentIds,
  agentName,
  agentsJson,
  remembered,
  removeHint,
} from "./agents.ts";
import {
  ALL_INTERFACES,
  type MachineConfig,
  machineFile,
  pathsOf,
  serveArgs,
  upArgs,
} from "./config.ts";
import {
  gitEntries,
  processEnv,
  profileScript,
  type Setting,
  settingsFor,
} from "./settings.ts";
import { cloudflaredPath, TUNNEL_UNIT } from "./tunnel.ts";

export const UNIT = "devbox.service";
export const BACKUP_SERVICE = "devbox-backup.service";
export const BACKUP_TIMER = "devbox-backup.timer";
export const HUB_UNIT = "devbox-hub.service";
export const HUB_PORT = 3780;
export const SPOKE_UNIT = "devbox-spoke.service";

export type Supervisor = Data.TaggedEnum<{
  Systemd: { readonly scope: "system" | "user" };
  Detached: {};
}>;

export const Supervisor = Data.taggedEnum<Supervisor>();

export type ServeState = Data.TaggedEnum<{
  Running: { readonly pids: readonly number[] };
  Stale: { readonly pids: readonly number[] };
  Stopped: {};
}>;

export const ServeState = Data.taggedEnum<ServeState>();

export type Context = {
  readonly home: string;
  readonly etc: string;
  readonly user: string;
  readonly self: readonly string[];
  readonly path: string;
  readonly settings: readonly Setting[];
};

export type BackupFact = Data.TaggedEnum<{
  Off: { readonly why: string };
  On: {
    readonly missing: readonly string[];
    readonly apt: boolean;
    readonly timer: { readonly enabled: boolean; readonly active: boolean };
  };
}>;

export const BackupFact = Data.taggedEnum<BackupFact>();

export type Facts = {
  readonly sudo: boolean;
  readonly files: ReadonlyMap<string, Option.Option<string>>;
  readonly git: ReadonlyMap<string, readonly string[]>;
  readonly links: ReadonlyMap<string, Option.Option<string>>;
  readonly dataIsHome: boolean;
  readonly ghLoginSaved: boolean;
  readonly t3: {
    readonly installed: Option.Option<string>;
    readonly latest: Option.Option<string>;
  };
  readonly supervisor: Supervisor;
  readonly serve: ServeState;
  readonly linger: Option.Option<boolean>;
  readonly backup: BackupFact;
  readonly hub: {
    /** The unit is enabled and active. */
    readonly running: boolean;
    /** The page in this checkout was built from the `apps/hub` it holds now. */
    readonly built: boolean;
    /** The checkout that holds `apps/hub`. A compiled devbox has none. */
    readonly checkout: Option.Option<string>;
  };
  /** The spoke's unit is enabled and active. */
  readonly spoke: { readonly running: boolean };
  readonly tunnel: {
    /** Its unit is enabled and active. */
    readonly running: boolean;
    /** `~/.local/bin/cloudflared` is there, and a link to it leads somewhere. */
    readonly cloudflared: boolean;
  };
  readonly agents: {
    readonly saved: Option.Option<AgentIds>;
    readonly present: ReadonlyMap<AgentId, boolean>;
  };
};

export type Change = Data.TaggedEnum<{
  Write: {
    readonly path: string;
    readonly content: string;
    readonly privileged: boolean;
    // Applies only when the file is created.
    readonly mode: Option.Option<number>;
  };
  Git: { readonly key: string; readonly values: readonly string[] };
  Link: { readonly path: string; readonly target: string };
  InstallT3: { readonly from: Option.Option<string>; readonly to: string };
  InstallAgent: { readonly id: AgentId };
  Linger: {};
  InstallTools: { readonly packages: readonly string[] };
  EnableTimer: {};
  Start: { readonly why: string; readonly stop: readonly number[] };
  BuildHub: { readonly checkout: string };
  EnableHub: { readonly address: string };
  RemoveHub: { readonly path: string; readonly privileged: boolean };
  EnableSpoke: { readonly address: string };
  RemoveSpoke: { readonly path: string; readonly privileged: boolean };
  InstallCloudflared: { readonly path: string };
  EnableTunnel: {};
  RemoveTunnel: { readonly path: string; readonly privileged: boolean };
}>;

export const Change = Data.taggedEnum<Change>();

export type Skip = { readonly what: string; readonly why: string };

export type Plan = {
  readonly changes: readonly Change[];
  readonly skips: readonly Skip[];
};

export const t3SettingsPath = (baseDir: string) =>
  join(baseDir, "userdata", "settings.json");

type LinkedEnvironments = Data.TaggedEnum<{
  On: {};
  Enable: { readonly content: string };
  NotAnObject: {};
}>;

const LinkedEnvironments = Data.taggedEnum<LinkedEnvironments>();

const SettingsObject = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown)
);

// T3 refuses `t3 environment link` unless this is true, and its settings.json has no other
// switch for it than a Settings screen a headless box never opens.
export const enableLinkedEnvironments = (
  current: Option.Option<string>
): LinkedEnvironments => {
  const settings = Option.match(current, {
    onNone: () => Option.some<Record<string, unknown>>({}),
    onSome: (text) => Schema.decodeUnknownOption(SettingsObject)(text),
  });

  if (Option.isNone(settings)) {
    return LinkedEnvironments.NotAnObject();
  }

  if (settings.value.linkedEnvironmentsEnabled === true) {
    return LinkedEnvironments.On();
  }

  return LinkedEnvironments.Enable({
    content: `${JSON.stringify({ ...settings.value, linkedEnvironmentsEnabled: true }, null, 2)}\n`,
  });
};

export const machineInfoPath = (etc: string) => join(etc, "machine-info");
export const profilePath = (etc: string) => join(etc, "profile.d", "devbox.sh");

export const unitPath = (scope: "system" | "user", ctx: Context, unit = UNIT) =>
  scope === "system"
    ? join(ctx.etc, "systemd", "system", unit)
    : join(ctx.home, ".config", "systemd", "user", unit);

// T3 Code names the environment after PRETTY_HOSTNAME in /etc/machine-info before the hostname.
export const withPrettyHostname = (current: string, name: string): string =>
  [
    `PRETTY_HOSTNAME=${name}`,
    ...current
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("PRETTY_HOSTNAME=")),
  ]
    .map((line) => `${line}\n`)
    .join("");

const systemdQuote = (arg: string): string =>
  /^[A-Za-z0-9_@+=:,./-]+$/.test(arg)
    ? arg
    : `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$")}"`;

const SYSTEM_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const pathLine = (config: MachineConfig) =>
  `Environment=${systemdQuote(`PATH=${processEnv(settingsFor(config.data), SYSTEM_PATH).PATH}`)}`;

export const unitFile = (
  scope: "system" | "user",
  config: MachineConfig,
  ctx: Context
): string =>
  [
    "[Unit]",
    "Description=T3 Code, kept running by devbox",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    ...(scope === "system" ? [`User=${ctx.user}`] : []),
    pathLine(config),
    `ExecStart=${[...ctx.self, ...serveArgs(config)].map(systemdQuote).join(" ")}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    `WantedBy=${scope === "system" ? "multi-user.target" : "default.target"}`,
    "",
  ].join("\n");

export const backupServiceFile = (
  scope: "system" | "user",
  config: MachineConfig,
  ctx: Context
): string =>
  [
    "[Unit]",
    "Description=Back up agent memory and threads with restic, run by devbox",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    ...(scope === "system" ? [`User=${ctx.user}`] : []),
    pathLine(config),
    `ExecStart=${[...ctx.self, "backup", "run"].map(systemdQuote).join(" ")}`,
    "Nice=10",
    "IOSchedulingClass=idle",
    "",
  ].join("\n");

export const hubEnvPath = (home: string) =>
  join(home, ".config", "devbox", "hub", "env");

const neverAllInterfaces = (bind: string): string =>
  bind === ALL_INTERFACES || bind === "::" ? "127.0.0.1" : bind;

export const hubHost = (config: MachineConfig): string =>
  neverAllInterfaces(config.host);

export const hubArgs = (config: MachineConfig): readonly string[] => [
  "hub",
  "--host",
  hubHost(config),
  "--port",
  String(HUB_PORT),
  "--t3-port",
  String(config.port),
];

export const hubUnitFile = (
  scope: "system" | "user",
  config: MachineConfig,
  ctx: Context
): string =>
  [
    "[Unit]",
    "Description=devbox hub, the page of every machine, kept running by devbox",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    ...(scope === "system" ? [`User=${ctx.user}`] : []),
    pathLine(config),
    `EnvironmentFile=-${hubEnvPath(ctx.home)}`,
    `ExecStart=${[...ctx.self, ...hubArgs(config)].map(systemdQuote).join(" ")}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    `WantedBy=${scope === "system" ? "multi-user.target" : "default.target"}`,
    "",
  ].join("\n");

export const spokeArgs = (config: MachineConfig): readonly string[] => [
  "spoke",
  "--host",
  neverAllInterfaces(config.host),
  "--port",
  String(SPOKE_PORT),
  ...config.trust.flatMap((key) => ["--trust", key]),
];

export const spokeUnitFile = (
  scope: "system" | "user",
  config: MachineConfig,
  ctx: Context
): string =>
  [
    "[Unit]",
    "Description=devbox spoke, which answers the hub, kept running by devbox",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    ...(scope === "system" ? [`User=${ctx.user}`] : []),
    pathLine(config),
    `ExecStart=${[...ctx.self, ...spokeArgs(config)].map(systemdQuote).join(" ")}`,
    // The `devbox up` it starts for an update must outlive a restart of the spoke itself.
    "KillMode=process",
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    `WantedBy=${scope === "system" ? "multi-user.target" : "default.target"}`,
    "",
  ].join("\n");

/**
 * The unit the README gives. cloudflared reads the token from its file, so the token is never on a
 * command line. A system unit runs as the user, and `%h` there would be root's home.
 */
export const tunnelUnitFile = (
  scope: "system" | "user",
  ctx: Context
): string => {
  const at = (path: string) =>
    scope === "user" ? `%h/${path}` : systemdQuote(join(ctx.home, path));

  return [
    "[Unit]",
    "Description=Cloudflare Tunnel for T3 Code",
    "",
    "[Service]",
    ...(scope === "system" ? [`User=${ctx.user}`] : []),
    `ExecStart=${at(".local/bin/cloudflared")} tunnel --no-autoupdate run --token-file ${at(".config/cloudflared/token")}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    `WantedBy=${scope === "system" ? "multi-user.target" : "default.target"}`,
    "",
  ].join("\n");
};

export const backupTimerFile = (): string =>
  [
    "[Unit]",
    "Description=Nightly agent backup, run by devbox",
    "",
    "[Timer]",
    "OnCalendar=*-*-* 03:30 Asia/Bangkok",
    "RandomizedDelaySec=20m",
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");

export const machineJson = (config: MachineConfig): string =>
  `${JSON.stringify(
    {
      name: config.name,
      url: Option.getOrUndefined(config.publicUrl),
      host: config.host === ALL_INTERFACES ? undefined : config.host,
      port: config.port,
      data: config.data,
      baseDir: config.baseDir,
      t3: join(config.data, ".local", "bin", "t3"),
      up: upArgs(config),
    },
    null,
    2
  )}\n`;

export const persistLinks = (
  config: MachineConfig,
  ctx: Context,
  facts: Facts
) =>
  facts.dataIsHome
    ? []
    : [
        {
          path: join(ctx.home, ".agents"),
          target: join(config.data, ".agents"),
        },
        ...(facts.ghLoginSaved
          ? [
              {
                path: join(ctx.home, ".config", "gh"),
                target: join(config.data, ".config", "gh"),
              },
            ]
          : []),
      ];

const sameValues = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

export const plan = (
  config: MachineConfig,
  ctx: Context,
  facts: Facts
): Plan => {
  const changes: Change[] = [];
  const skips: Skip[] = [];

  const current = (path: string) =>
    Option.flatten(Option.fromUndefinedOr(facts.files.get(path)));

  const write = (
    path: string,
    content: string,
    privileged: boolean,
    mode: Option.Option<number> = Option.none()
  ) => {
    if (Option.contains(current(path), content)) {
      return false;
    }

    if (privileged && !facts.sudo) {
      skips.push({ what: path, why: "no passwordless sudo" });

      return false;
    }

    changes.push(Change.Write({ path, content, privileged, mode }));

    return true;
  };

  for (const link of persistLinks(config, ctx, facts)) {
    const now = Option.flatten(
      Option.fromUndefinedOr(facts.links.get(link.path))
    );

    if (!Option.contains(now, link.target)) {
      changes.push(Change.Link(link));
    }
  }

  for (const { key, values } of gitEntries(ctx.settings)) {
    if (!sameValues(facts.git.get(key) ?? [], values)) {
      changes.push(Change.Git({ key, values }));
    }
  }

  const machineInfo = machineInfoPath(ctx.etc);
  write(
    machineInfo,
    withPrettyHostname(
      Option.getOrElse(current(machineInfo), () => ""),
      config.name
    ),
    true
  );
  write(profilePath(ctx.etc), profileScript(ctx.settings, ctx.user), true);
  write(machineFile(ctx.home), machineJson(config), false);

  if (remembered(config.agents)) {
    write(pathsOf(config.data).agents, agentsJson(config.agents.ids), false);
  }

  const t3Settings = t3SettingsPath(config.baseDir);
  LinkedEnvironments.$match(enableLinkedEnvironments(current(t3Settings)), {
    On: () => undefined,
    Enable: ({ content }) =>
      write(t3Settings, content, false, Option.some(0o600)),
    NotAnObject: () =>
      skips.push({
        what: t3Settings,
        why: "not a JSON object, so linked environments stays as it is; turn it on in Settings → Labs",
      }),
  });

  const unitChanged = Supervisor.$match(facts.supervisor, {
    Systemd: ({ scope }) =>
      write(
        unitPath(scope, ctx),
        unitFile(scope, config, ctx),
        scope === "system"
      ),
    Detached: () => false,
  });

  const { installed, latest } = facts.t3;

  const t3Changed =
    Option.isSome(latest) && !Option.contains(installed, latest.value);

  if (Option.isSome(latest) && t3Changed) {
    changes.push(Change.InstallT3({ from: installed, to: latest.value }));
  } else if (Option.isNone(latest) && Option.isSome(installed)) {
    skips.push({
      what: `t3@${config.channel}`,
      why: `npm did not answer, keeping ${installed.value}`,
    });
  }

  const toInstall = config.agents.ids.filter(
    (id) => facts.agents.present.get(id) !== true
  );

  for (const id of toInstall) {
    changes.push(Change.InstallAgent({ id }));
  }

  for (const id of Option.getOrElse(facts.agents.saved, () => [])) {
    if (!config.agents.ids.includes(id))
      skips.push({
        what: agentName(id),
        why: `no longer chosen, left installed. ${removeHint(id, config.data)}`,
      });
  }

  if (Option.contains(facts.linger, false)) {
    changes.push(Change.Linger());
  }

  BackupFact.$match(facts.backup, {
    Off: ({ why }) => skips.push({ what: "backups", why }),
    On: ({ missing, apt, timer }) =>
      Supervisor.$match(facts.supervisor, {
        Detached: () =>
          skips.push({
            what: "backup timer",
            why: "no systemd here, schedule `devbox backup run` with cron",
          }),
        Systemd: ({ scope }) => {
          if (missing.length > 0 && !(apt && facts.sudo)) {
            return skips.push({
              what: "backup timer",
              why: `${missing.join(" and ")} missing, and apt with passwordless sudo is needed to install them`,
            });
          }

          if (missing.length > 0) {
            changes.push(Change.InstallTools({ packages: missing }));
          }

          const service = write(
            unitPath(scope, ctx, BACKUP_SERVICE),
            backupServiceFile(scope, config, ctx),
            scope === "system"
          );

          const timerFile = write(
            unitPath(scope, ctx, BACKUP_TIMER),
            backupTimerFile(),
            scope === "system"
          );

          if (service || timerFile || !timer.enabled || !timer.active) {
            changes.push(Change.EnableTimer());
          }
        },
      }),
  });

  const why = ServeState.$match(facts.serve, {
    Running: () =>
      unitChanged
        ? "the unit changed"
        : t3Changed
          ? "T3 Code was updated"
          : toInstall.length > 0
            ? "an agent CLI was installed"
            : undefined,
    Stale: () => "its flags changed",
    Stopped: () => "it was not running",
  });

  const stop = ServeState.$match(facts.serve, {
    Running: ({ pids }) => pids,
    Stale: ({ pids }) => pids,
    Stopped: () => [],
  });

  if (why !== undefined) {
    changes.push(Change.Start({ why, stop }));
  }

  Supervisor.$match(facts.supervisor, {
    Detached: () => {
      if (config.hub) {
        skips.push({
          what: "hub",
          why: "no systemd here, run `devbox hub` yourself",
        });
      }
    },
    Systemd: ({ scope }) => {
      const path = unitPath(scope, ctx, HUB_UNIT);

      if (!config.hub) {
        if (Option.isSome(current(path))) {
          changes.push(
            Change.RemoveHub({ path, privileged: scope === "system" })
          );
        }

        return;
      }

      const wrote = write(
        path,
        hubUnitFile(scope, config, ctx),
        scope === "system"
      );

      if (wrote || !facts.hub.running) {
        changes.push(
          Change.EnableHub({ address: `${hubHost(config)}:${HUB_PORT}` })
        );
      }

      if (!facts.hub.built) {
        Option.match(facts.hub.checkout, {
          onNone: () =>
            skips.push({
              what: "hub page",
              why: "this devbox is not a checkout, so build apps/hub in one and pass --ui",
            }),
          onSome: (checkout) => changes.push(Change.BuildHub({ checkout })),
        });
      }
    },
  });

  Supervisor.$match(facts.supervisor, {
    Detached: () => {
      if (config.spoke) {
        skips.push({
          what: "spoke",
          why: "no systemd here, run `devbox spoke` yourself",
        });
      }
    },
    Systemd: ({ scope }) => {
      const path = unitPath(scope, ctx, SPOKE_UNIT);

      if (!config.spoke) {
        if (Option.isSome(current(path))) {
          changes.push(
            Change.RemoveSpoke({ path, privileged: scope === "system" })
          );
        }

        return;
      }

      const wrote = write(
        path,
        spokeUnitFile(scope, config, ctx),
        scope === "system"
      );

      if (wrote || !facts.spoke.running) {
        changes.push(
          Change.EnableSpoke({ address: `${hubHost(config)}:${SPOKE_PORT}` })
        );
      }
    },
  });

  Supervisor.$match(facts.supervisor, {
    Detached: () => {
      if (config.tunnel) {
        skips.push({
          what: "tunnel",
          why: "no systemd here, run `cloudflared tunnel run --token-file ~/.config/cloudflared/token` yourself",
        });
      }
    },
    Systemd: ({ scope }) => {
      const path = unitPath(scope, ctx, TUNNEL_UNIT);

      if (!config.tunnel) {
        if (Option.isSome(current(path))) {
          changes.push(
            Change.RemoveTunnel({ path, privileged: scope === "system" })
          );
        }

        return;
      }

      if (!facts.tunnel.cloudflared) {
        changes.push(
          Change.InstallCloudflared({ path: cloudflaredPath(ctx.home) })
        );
      }

      const wrote = write(path, tunnelUnitFile(scope, ctx), scope === "system");

      if (wrote || !facts.tunnel.cloudflared || !facts.tunnel.running) {
        changes.push(Change.EnableTunnel());
      }
    },
  });

  return { changes, skips };
};
