import { Option, Schema } from "effect";
import { Flag } from "effect/cli";
import { join } from "node:path";
import { type AbsolutePath, absolutePath } from "../migrate/paths.ts";

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

const Port = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })));

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
  publicUrl: Flag.String("public-url").pipe(
    Flag.withDescription("public origin an edge proxy serves this machine on"),
    Flag.withSchema(PublicUrl),
    Flag.map((url) => url.replace(/\/$/, "")),
    Flag.optional,
  ),
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
  supervisor: Flag.Literals("supervisor", SUPERVISORS).pipe(
    Flag.withDescription(
      "what keeps T3 running: a systemd system or user unit, or a detached process (default auto)",
    ),
    Flag.withDefault("auto"),
  ),
};

export type ServeConfig = {
  readonly data: AbsolutePath;
  readonly port: number;
  readonly baseDir: AbsolutePath;
  readonly workspace: AbsolutePath;
  readonly publicUrl: Option.Option<string>;
  readonly setup: boolean;
};

export type MachineConfig = ServeConfig & {
  readonly name: string;
  readonly channel: string;
  readonly supervisor: Supervisor;
};

type ServeFlags = {
  readonly data: Option.Option<string>;
  readonly port: number;
  readonly baseDir: Option.Option<string>;
  readonly workspace: Option.Option<string>;
  readonly publicUrl: Option.Option<string>;
  readonly setup: boolean;
};

type UpFlags = ServeFlags & {
  readonly name: Option.Option<string>;
  readonly channel: string;
  readonly supervisor: Supervisor;
};

export const serveConfig = (flags: ServeFlags, home: AbsolutePath): ServeConfig => {
  const data = Option.match(flags.data, { onNone: () => home, onSome: (d) => absolutePath(d) });
  const under = (value: Option.Option<string>, fallback: string) =>
    absolutePath(Option.getOrElse(value, () => join(data, fallback)));
  return {
    data,
    port: flags.port,
    baseDir: under(flags.baseDir, ".t3"),
    workspace: under(flags.workspace, "."),
    publicUrl: flags.publicUrl,
    setup: flags.setup,
  };
};

export const machineConfig = (
  flags: UpFlags,
  home: AbsolutePath,
  hostname: string,
): MachineConfig => ({
  ...serveConfig(flags, home),
  name: Option.getOrElse(flags.name, () => hostname),
  channel: flags.channel,
  supervisor: flags.supervisor,
});

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
  ...Option.match(config.publicUrl, { onNone: () => [], onSome: (url) => ["--public-url", url] }),
  ...(config.setup ? [] : ["--no-setup"]),
];

export const pathsOf = (data: string) => ({
  prefix: join(data, ".local"),
  t3: join(data, ".local", "bin", "t3"),
  t3Package: join(data, ".local", "lib", "node_modules", "t3", "package.json"),
  mise: join(data, ".local", "bin", "mise"),
  logs: join(data, ".devbox-logs"),
  skillsStamp: join(data, ".devbox-skills"),
});

export const machineFile = (home: string) => join(home, ".config", "devbox", "machine.json");

export const MachineFile = Schema.Struct({
  name: Schema.String,
  url: Schema.optional(Schema.String),
  port: Schema.Number,
  baseDir: Schema.String,
  t3: Schema.String,
});
export type MachineFile = typeof MachineFile.Type;
