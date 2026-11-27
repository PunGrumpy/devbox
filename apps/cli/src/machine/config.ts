import { Effect, Option, Result, Schema } from "effect";
import { Flag } from "effect/cli";
import { join } from "node:path";
import { UsageError } from "../errors.ts";
import { type AbsolutePath, absolutePath } from "../migrate/paths.ts";
import { type AgentChoice, type AgentsFlag, agentsFile, parseAgentsFlag } from "./agents.ts";

export const Name = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
      message: "use letters, digits, '.', '_' and '-'",
    }),
  ),
);

export const PublicUrl = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^https?:\/\/[^/\s?#]+\/?$/, {
      message: "expected an origin such as https://box.example.com",
    }),
  ),
);

export const originFlag = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withDescription(description),
    Flag.withSchema(PublicUrl),
    Flag.map((url) => url.replace(/\/$/, "")),
    Flag.optional,
  );

export const BindHost = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[A-Za-z0-9._:-]+$/, {
      message: "expected an IP address or host name such as 100.64.0.7",
    }),
  ),
);

// Listening on every interface is what T3 did before --host existed, so a box without the flag
// keeps the same unit file.
export const ALL_INTERFACES = "0.0.0.0";

// Where to knock to see whether T3 answers: a wildcard address is not one you can connect to.
export const probeHost = (bind: string): string =>
  bind === ALL_INTERFACES || bind === "::" ? "127.0.0.1" : bind;

export const Port = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })));

const Channel = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/, { message: "expected an npm tag" }),
  ),
);

export const SUPERVISORS = ["auto", "system", "user", "detached"] as const;
export type Supervisor = (typeof SUPERVISORS)[number];

export const serveFlags = {
  data: Flag.String("data").pipe(
    Flag.withDescription("directory that survives a rebuild (default $HOME)"),
    Flag.optional,
  ),
  port: Flag.Int("port").pipe(
    Flag.withDescription("port T3 Code answers on (default 3773)"),
    Flag.withSchema(Port),
    Flag.withDefault(3773),
  ),
  baseDir: Flag.String("base-dir").pipe(
    Flag.withDescription("T3 Code data directory (default <data>/.t3)"),
    Flag.optional,
  ),
  workspace: Flag.String("workspace").pipe(
    Flag.withDescription("working directory for agent sessions (default <data>)"),
    Flag.optional,
  ),
  host: Flag.String("host").pipe(
    Flag.withDescription(
      "address T3 Code listens on, for example a Tailscale IP (default 0.0.0.0, every interface; not with --public-url)",
    ),
    Flag.withSchema(BindHost),
    Flag.optional,
  ),
  publicUrl: originFlag("public-url", "public origin an edge proxy serves this machine on"),
  setup: Flag.Boolean("setup").pipe(
    Flag.withDescription(
      "after T3 starts, install browser libraries, Go, Rust and agent skills (default on, --no-setup skips)",
    ),
    Flag.withDefault(true),
  ),
};

export const upFlags = {
  ...serveFlags,
  name: Flag.String("name").pipe(
    Flag.withDescription("environment name T3 Code shows (default the hostname)"),
    Flag.withSchema(Name),
    Flag.optional,
  ),
  channel: Flag.String("channel").pipe(
    Flag.withDescription("T3 Code release channel on npm (default nightly)"),
    Flag.withSchema(Channel),
    Flag.withDefault("nightly"),
  ),
  hub: Flag.Boolean("hub").pipe(
    Flag.withDescription(
      "also keep `devbox hub` running, on --host when that is one address and on 127.0.0.1 otherwise",
    ),
    Flag.withDefault(false),
  ),
  supervisor: Flag.Literals("supervisor", SUPERVISORS).pipe(
    Flag.withDescription(
      "what keeps T3 running: a systemd system or user unit, or a detached process (default auto)",
    ),
    Flag.withDefault("auto"),
  ),
  agents: Flag.String("agents").pipe(
    Flag.withDescription(
      "agent CLIs to install: pick, none, or a list like claude,codex. Saved in <data>, so later runs ask nothing (default: ask once on a terminal)",
    ),
    Flag.filterMap(
      (text) => Result.getSuccess(parseAgentsFlag(text)),
      (text) =>
        Result.match(parseAgentsFlag(text), { onSuccess: () => "", onFailure: (why) => why }),
    ),
    Flag.optional,
  ),
};

export type ServeConfig = {
  readonly data: AbsolutePath;
  readonly port: number;
  readonly baseDir: AbsolutePath;
  readonly workspace: AbsolutePath;
  readonly host: string;
  readonly publicUrl: Option.Option<string>;
  readonly setup: boolean;
};

export type MachineConfig = ServeConfig & {
  readonly name: string;
  readonly channel: string;
  readonly supervisor: Supervisor;
  readonly agents: AgentChoice;
  readonly hub: boolean;
};

type ServeFlags = {
  readonly data: Option.Option<string>;
  readonly port: number;
  readonly baseDir: Option.Option<string>;
  readonly workspace: Option.Option<string>;
  readonly host: Option.Option<string>;
  readonly publicUrl: Option.Option<string>;
  readonly setup: boolean;
};

type UpFlags = ServeFlags & {
  readonly name: Option.Option<string>;
  readonly channel: string;
  readonly supervisor: Supervisor;
  readonly agents: Option.Option<AgentsFlag>;
  readonly hub: boolean;
};

export const serveConfig = (flags: ServeFlags, home: AbsolutePath) =>
  Effect.gen(function* () {
    if (Option.isSome(flags.host) && Option.isSome(flags.publicUrl))
      return yield* new UsageError({
        message: "--host and --public-url cannot be used together",
        hint: "behind --public-url, T3 listens on 127.0.0.1 and the proxy takes every interface",
      });
    const data = Option.match(flags.data, { onNone: () => home, onSome: (d) => absolutePath(d) });
    const under = (value: Option.Option<string>, fallback: string) =>
      absolutePath(Option.getOrElse(value, () => join(data, fallback)));
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
  agents: AgentChoice,
) =>
  Effect.map(serveConfig(flags, home), (config): MachineConfig => ({
    ...config,
    name: Option.getOrElse(flags.name, () => hostname),
    channel: flags.channel,
    supervisor: flags.supervisor,
    agents,
    hub: flags.hub,
  }));

export const serveArgs = (config: ServeConfig): ReadonlyArray<string> => [
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
  ...Option.match(config.publicUrl, { onNone: () => [], onSome: (url) => ["--public-url", url] }),
  ...(config.setup ? [] : ["--no-setup"]),
];

export const pathsOf = (data: string) => ({
  prefix: join(data, ".local"),
  t3: join(data, ".local", "bin", "t3"),
  t3Package: join(data, ".local", "lib", "node_modules", "t3", "package.json"),
  mise: join(data, ".local", "bin", "mise"),
  npmShim: join(data, ".local", "share", "mise", "shims", "npm"),
  logs: join(data, ".devbox-logs"),
  skillsStamp: join(data, ".devbox-skills"),
  agents: agentsFile(data),
});

export const machineFile = (home: string) => join(home, ".config", "devbox", "machine.json");

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
