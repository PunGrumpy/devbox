import path from "node:path";

import { Effect, Option, Result, Schema } from "effect";
import { Flag } from "effect/cli";

import { UsageError } from "../errors.ts";
import { absolutePath } from "../migrate/paths.ts";
import type { AbsolutePath } from "../migrate/paths.ts";
import { PublicKey } from "../spoke/signed.ts";
import { agentsFile, parseAgentsFlag } from "./agents.ts";
import type { AgentChoice, AgentsFlag } from "./agents.ts";

export const Name = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, {
      message: "use letters, digits, '.', '_' and '-'",
    })
  )
);

export const PublicUrl = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^https?:\/\/[^/\s?#]+\/?$/u, {
      message: "expected an origin such as https://box.example.com",
    })
  )
);

export const originFlag = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withDescription(description),
    Flag.withSchema(PublicUrl),
    Flag.map((url) => url.replace(/\/$/u, "")),
    Flag.optional
  );

export const BindHost = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[A-Za-z0-9._:-]+$/u, {
      message: "expected an IP address or host name such as 100.64.0.7",
    })
  )
);

/**
 * Listening on every interface is what T3 did before --host existed, so a box without the flag
 * keeps the same unit file.
 */
export const ALL_INTERFACES = "0.0.0.0";

/** Where to knock to see whether T3 answers: a wildcard address is not one you can connect to. */
export const probeHost = (bind: string) =>
  bind === ALL_INTERFACES || bind === "::" ? "127.0.0.1" : bind;

export const Port = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))
);

const Channel = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/u, {
      message: "expected an npm tag",
    })
  )
);

export const SUPERVISORS = ["auto", "system", "user", "detached"] as const;

export type Supervisor = (typeof SUPERVISORS)[number];

export const serveFlags = {
  data: Flag.String("data").pipe(
    Flag.withDescription("directory that survives a rebuild (default $HOME)"),
    Flag.optional
  ),
  port: Flag.Int("port").pipe(
    Flag.withDescription("port T3 Code answers on (default 3773)"),
    Flag.withSchema(Port),
    Flag.withDefault(3773)
  ),
  baseDir: Flag.String("base-dir").pipe(
    Flag.withDescription("T3 Code data directory (default <data>/.t3)"),
    Flag.optional
  ),
  workspace: Flag.String("workspace").pipe(
    Flag.withDescription(
      "working directory for agent sessions (default <data>)"
    ),
    Flag.optional
  ),
  host: Flag.String("host").pipe(
    Flag.withDescription(
      "address T3 Code listens on, for example a Tailscale IP, or the proxy does with --public-url (default 0.0.0.0, every interface)"
    ),
    Flag.withSchema(BindHost),
    Flag.optional
  ),
  publicUrl: originFlag(
    "public-url",
    "public origin an edge proxy serves this machine on"
  ),
  setup: Flag.Boolean("setup").pipe(
    Flag.withDescription(
      "after T3 starts, install browser libraries, Go, Rust and agent skills (default on, --no-setup skips)"
    ),
    Flag.withDefault(true)
  ),
};

export const upFlags = {
  ...serveFlags,
  name: Flag.String("name").pipe(
    Flag.withDescription(
      "environment name T3 Code shows (default the hostname)"
    ),
    Flag.withSchema(Name),
    Flag.optional
  ),
  channel: Flag.String("channel").pipe(
    Flag.withDescription("T3 Code release channel on npm (default nightly)"),
    Flag.withSchema(Channel),
    Flag.withDefault("nightly")
  ),
  hub: Flag.Boolean("hub").pipe(
    Flag.withDescription(
      "also keep `devbox hub` running, on --host when that is one address and on 127.0.0.1 otherwise"
    ),
    Flag.withDefault(false)
  ),
  spoke: Flag.Boolean("spoke").pipe(
    Flag.withDescription(
      "also keep `devbox spoke` running, which tells the hub this machine's load, memory and disk"
    ),
    Flag.withDefault(false)
  ),
  tunnel: Flag.Boolean("tunnel").pipe(
    Flag.withDescription(
      "also keep a Cloudflare Tunnel running with the token in ~/.config/cloudflared/token, which the hub saves when it publishes this machine"
    ),
    Flag.withDefault(false)
  ),
  trust: Flag.String("trust").pipe(
    Flag.withDescription(
      "with --spoke, a hub key (`devbox hub key` prints it) whose hub may update T3 Code here (repeatable)"
    ),
    Flag.withSchema(PublicKey),
    Flag.atLeast(0)
  ),
  supervisor: Flag.Literals("supervisor", SUPERVISORS).pipe(
    Flag.withDescription(
      "what keeps T3 running: a systemd system or user unit, or a detached process (default auto)"
    ),
    Flag.withDefault("auto")
  ),
  agents: Flag.String("agents").pipe(
    Flag.withDescription(
      "agent CLIs to install: pick, none, or a list like claude,codex. Saved in <data>, so later runs ask nothing (default: ask once on a terminal)"
    ),
    Flag.filterMap(
      (text) => Result.getSuccess(parseAgentsFlag(text)),
      (text) =>
        Result.match(parseAgentsFlag(text), {
          onSuccess: () => "",
          onFailure: (why) => why,
        })
    ),
    Flag.optional
  ),
};

export interface ServeConfig {
  readonly data: AbsolutePath;
  readonly port: number;
  readonly baseDir: AbsolutePath;
  readonly workspace: AbsolutePath;
  readonly host: string;
  readonly publicUrl: Option.Option<string>;
  readonly setup: boolean;
}

export type MachineConfig = ServeConfig & {
  readonly name: string;
  readonly channel: string;
  readonly supervisor: Supervisor;
  readonly agents: AgentChoice;
  readonly hub: boolean;
  readonly spoke: boolean;
  /** Hub keys the spoke takes updates from. */
  readonly trust: readonly string[];
  /** Keep `cloudflared-t3.service` running. */
  readonly tunnel: boolean;
};

interface ServeFlags {
  readonly data: Option.Option<string>;
  readonly port: number;
  readonly baseDir: Option.Option<string>;
  readonly workspace: Option.Option<string>;
  readonly host: Option.Option<string>;
  readonly publicUrl: Option.Option<string>;
  readonly setup: boolean;
}

type UpFlags = ServeFlags & {
  readonly name: Option.Option<string>;
  readonly channel: string;
  readonly supervisor: Supervisor;
  readonly agents: Option.Option<AgentsFlag>;
  readonly hub: boolean;
  readonly spoke: boolean;
  readonly trust: readonly string[];
  readonly tunnel: boolean;
};

export const serveConfig = (flags: ServeFlags, home: AbsolutePath) =>
  Effect.sync(() => {
    const data = Option.match(flags.data, {
      onNone: () => home,
      onSome: (d) => absolutePath(d),
    });

    const under = (value: Option.Option<string>, fallback: string) =>
      absolutePath(Option.getOrElse(value, () => path.join(data, fallback)));

    return {
      data,
      port: flags.port,
      baseDir: under(flags.baseDir, ".t3"),
      workspace: under(flags.workspace, "."),
      host: Option.getOrElse(flags.host, () => ALL_INTERFACES),
      publicUrl: flags.publicUrl,
      setup: flags.setup,
    } satisfies ServeConfig;
  });

export const machineConfig = (
  flags: UpFlags,
  home: AbsolutePath,
  hostname: string,
  agents: AgentChoice
) =>
  Effect.gen(function* () {
    if (flags.trust.length > 0 && !flags.spoke) {
      return yield* new UsageError({
        message: "--trust needs --spoke",
        hint: "the spoke is what takes updates from a hub",
      });
    }

    const config = yield* serveConfig(flags, home);

    return {
      ...config,
      name: Option.getOrElse(flags.name, () => hostname),
      channel: flags.channel,
      supervisor: flags.supervisor,
      agents,
      hub: flags.hub,
      spoke: flags.spoke,
      trust: [...new Set(flags.trust)],
      tunnel: flags.tunnel,
    } satisfies MachineConfig;
  });

export const serveArgs = (config: ServeConfig) => [
  "serve",
  "--data",
  config.data,
  "--port",
  String(config.port),
  "--base-dir",
  config.baseDir,
  "--workspace",
  config.workspace,
  ...(config.host === ALL_INTERFACES ? [] : ["--host", config.host]),
  ...Option.match(config.publicUrl, {
    onNone: () => [],
    onSome: (url) => ["--public-url", url],
  }),
  ...(config.setup ? [] : ["--no-setup"]),
];

/**
 * The flags of `devbox up` that make this config again, for the spoke to run when the hub asks for
 * an update. Paths are absolute, so it does not matter where it runs from. The agents are left
 * out: a later run reads the ones saved in <data>.
 */
export const upArgs = (config: MachineConfig) => [
  ...serveArgs(config).slice(1),
  "--name",
  config.name,
  "--channel",
  config.channel,
  "--supervisor",
  config.supervisor,
  ...(config.hub ? ["--hub"] : []),
  ...(config.spoke ? ["--spoke"] : []),
  ...config.trust.flatMap((key) => ["--trust", key]),
  ...(config.tunnel ? ["--tunnel"] : []),
];

export const pathsOf = (data: string) => ({
  prefix: path.join(data, ".local"),
  t3: path.join(data, ".local", "bin", "t3"),
  t3Package: path.join(
    data,
    ".local",
    "lib",
    "node_modules",
    "t3",
    "package.json"
  ),
  mise: path.join(data, ".local", "bin", "mise"),
  npmShim: path.join(data, ".local", "share", "mise", "shims", "npm"),
  logs: path.join(data, ".devbox-logs"),
  skillsStamp: path.join(data, ".devbox-skills"),
  agents: agentsFile(data),
});

export const machineFile = (home: string) =>
  path.join(home, ".config", "devbox", "machine.json");

export const MachineFile = Schema.Struct({
  name: Schema.String,
  url: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  port: Schema.Number,
  data: Schema.String,
  baseDir: Schema.String,
  t3: Schema.String,
});

export type MachineFile = typeof MachineFile.Type;
