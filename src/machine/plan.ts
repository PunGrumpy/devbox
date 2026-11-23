import { Data, Option } from "effect";
import { join } from "node:path";
import {
  type AgentId,
  type AgentIds,
  agentName,
  agentsJson,
  remembered,
  removeHint,
} from "./agents.ts";
import { type MachineConfig, machineFile, pathsOf, serveArgs } from "./config.ts";
import { gitEntries, processEnv, profileScript, type Setting, settingsFor } from "./settings.ts";

export const UNIT = "devbox.service";
export const BACKUP_SERVICE = "devbox-backup.service";
export const BACKUP_TIMER = "devbox-backup.timer";

export type Supervisor = Data.TaggedEnum<{
  Systemd: { readonly scope: "system" | "user" };
  Detached: {};
}>;
export const Supervisor = Data.taggedEnum<Supervisor>();

export type ServeState = Data.TaggedEnum<{
  Running: { readonly pids: ReadonlyArray<number> };
  Stale: { readonly pids: ReadonlyArray<number> };
  Stopped: {};
}>;
export const ServeState = Data.taggedEnum<ServeState>();

export type Context = {
  readonly home: string;
  readonly etc: string;
  readonly user: string;
  readonly self: ReadonlyArray<string>;
  readonly path: string;
  readonly settings: ReadonlyArray<Setting>;
};

export type BackupFact = Data.TaggedEnum<{
  Off: { readonly why: string };
  On: {
    readonly missing: ReadonlyArray<string>;
    readonly apt: boolean;
    readonly timer: { readonly enabled: boolean; readonly active: boolean };
  };
}>;
export const BackupFact = Data.taggedEnum<BackupFact>();

export type Facts = {
  readonly sudo: boolean;
  readonly files: ReadonlyMap<string, Option.Option<string>>;
  readonly git: ReadonlyMap<string, ReadonlyArray<string>>;
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
  readonly agents: {
    readonly saved: Option.Option<AgentIds>;
    readonly present: ReadonlyMap<AgentId, boolean>;
  };
};

export type Change = Data.TaggedEnum<{
  Write: { readonly path: string; readonly content: string; readonly privileged: boolean };
  Git: { readonly key: string; readonly values: ReadonlyArray<string> };
  Link: { readonly path: string; readonly target: string };
  InstallT3: { readonly from: Option.Option<string>; readonly to: string };
  InstallAgent: { readonly id: AgentId };
  Linger: {};
  InstallTools: { readonly packages: ReadonlyArray<string> };
  EnableTimer: {};
  Start: { readonly why: string; readonly stop: ReadonlyArray<number> };
}>;
export const Change = Data.taggedEnum<Change>();

export type Skip = { readonly what: string; readonly why: string };
export type Plan = { readonly changes: ReadonlyArray<Change>; readonly skips: ReadonlyArray<Skip> };

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
    ...current.split("\n").filter((line) => line !== "" && !line.startsWith("PRETTY_HOSTNAME=")),
  ]
    .map((line) => `${line}\n`)
    .join("");

const systemdQuote = (arg: string): string =>
  /^[A-Za-z0-9_@+=:,./-]+$/.test(arg)
    ? arg
    : `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$")}"`;

const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const pathLine = (config: MachineConfig) =>
  `Environment=${systemdQuote(`PATH=${processEnv(settingsFor(config.data), SYSTEM_PATH).PATH}`)}`;

export const unitFile = (scope: "system" | "user", config: MachineConfig, ctx: Context): string =>
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
  ctx: Context,
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
      port: config.port,
      data: config.data,
      baseDir: config.baseDir,
      t3: join(config.data, ".local", "bin", "t3"),
    },
    null,
    2,
  )}\n`;

export const persistLinks = (config: MachineConfig, ctx: Context, facts: Facts) =>
  facts.dataIsHome
    ? []
    : [
        { path: join(ctx.home, ".agents"), target: join(config.data, ".agents") },
        ...(facts.ghLoginSaved
          ? [{ path: join(ctx.home, ".config", "gh"), target: join(config.data, ".config", "gh") }]
          : []),
      ];

const sameValues = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

export const plan = (config: MachineConfig, ctx: Context, facts: Facts): Plan => {
  const changes: Array<Change> = [];
  const skips: Array<Skip> = [];
  const current = (path: string) => Option.flatten(Option.fromUndefinedOr(facts.files.get(path)));
  const write = (path: string, content: string, privileged: boolean) => {
    if (Option.contains(current(path), content)) return false;
    if (privileged && !facts.sudo) {
      skips.push({ what: path, why: "no passwordless sudo" });
      return false;
    }
    changes.push(Change.Write({ path, content, privileged }));
    return true;
  };

  for (const link of persistLinks(config, ctx, facts)) {
    const now = Option.flatten(Option.fromUndefinedOr(facts.links.get(link.path)));
    if (!Option.contains(now, link.target)) changes.push(Change.Link(link));
  }
  for (const { key, values } of gitEntries(ctx.settings)) {
    if (!sameValues(facts.git.get(key) ?? [], values)) changes.push(Change.Git({ key, values }));
  }

  const machineInfo = machineInfoPath(ctx.etc);
  write(
    machineInfo,
    withPrettyHostname(
      Option.getOrElse(current(machineInfo), () => ""),
      config.name,
    ),
    true,
  );
  write(profilePath(ctx.etc), profileScript(ctx.settings, ctx.user), true);
  write(machineFile(ctx.home), machineJson(config), false);
  if (remembered(config.agents))
    write(pathsOf(config.data).agents, agentsJson(config.agents.ids), false);

  const unitChanged = Supervisor.$match(facts.supervisor, {
    Systemd: ({ scope }) =>
      write(unitPath(scope, ctx), unitFile(scope, config, ctx), scope === "system"),
    Detached: () => false,
  });

  const { installed, latest } = facts.t3;
  const t3Changed = Option.isSome(latest) && !Option.contains(installed, latest.value);
  if (Option.isSome(latest) && t3Changed) {
    changes.push(Change.InstallT3({ from: installed, to: latest.value }));
  } else if (Option.isNone(latest) && Option.isSome(installed)) {
    skips.push({
      what: `t3@${config.channel}`,
      why: `npm did not answer, keeping ${installed.value}`,
    });
  }

  const toInstall = config.agents.ids.filter((id) => facts.agents.present.get(id) !== true);
  for (const id of toInstall) changes.push(Change.InstallAgent({ id }));
  for (const id of Option.getOrElse(facts.agents.saved, () => []))
    if (!config.agents.ids.includes(id))
      skips.push({
        what: agentName(id),
        why: `no longer chosen, left installed. ${removeHint(id, config.data)}`,
      });

  if (Option.contains(facts.linger, false)) changes.push(Change.Linger());

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
          if (missing.length > 0 && !(apt && facts.sudo))
            return skips.push({
              what: "backup timer",
              why: `${missing.join(" and ")} missing, and apt with passwordless sudo is needed to install them`,
            });
          if (missing.length > 0) changes.push(Change.InstallTools({ packages: missing }));
          const service = write(
            unitPath(scope, ctx, BACKUP_SERVICE),
            backupServiceFile(scope, config, ctx),
            scope === "system",
          );
          const timerFile = write(
            unitPath(scope, ctx, BACKUP_TIMER),
            backupTimerFile(),
            scope === "system",
          );
          if (service || timerFile || !timer.enabled || !timer.active)
            changes.push(Change.EnableTimer());
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
  if (why !== undefined) changes.push(Change.Start({ why, stop }));

  return { changes, skips };
};
