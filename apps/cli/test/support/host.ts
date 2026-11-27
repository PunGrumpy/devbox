import { Effect, Option } from "effect";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENTS } from "../../src/machine/agents.ts";
import type { Answer, Host, Proc, Ran, Request } from "../../src/machine/host.ts";
import type { Vitals } from "../../src/spoke/vitals.ts";

export type Posted = {
  readonly url: string;
  readonly body: string;
  readonly contentType: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type FakeMachine = {
  base: string;
  home: string;
  etc: string;
  sudo: boolean;
  systemd: boolean;
  userBus: boolean;
  linger: boolean;
  latest: string | undefined;
  git: Map<string, Array<string>>;
  units: Map<string, { active: boolean; enabled: boolean }>;
  processes: Array<Proc>;
  binaries: Set<string>;
  calls: Array<ReadonlyArray<string>>;
  probes: Array<{ readonly address: string; readonly port: number }>;
  /** URL to the body it answers with 200. Any other URL does not answer. */
  pages: Map<string, string>;
  fetches: Array<string>;
  posts: Array<Posted>;
  /** Whether a webhook answers. */
  webhookUp: boolean;
  /**
   * How a POST is answered, when not the way a webhook is: false is no 2xx, true a 2xx with an
   * empty body, and a string the body of a 2xx.
   */
  answerPost: (posted: Posted) => boolean | string | undefined;
  /** Answers `host.request`, by default with nothing, as if no server answered. */
  answer: (url: string, request: Request) => Answer | undefined;
  /** Every `host.request`, in order. */
  requests: Array<{ readonly url: string } & Request>;
  platform: string;
  vitals: Vitals;
  /** The directories vitals were asked for. */
  vitalsAsked: Array<string>;
  runs: Array<{
    argv: ReadonlyArray<string>;
    env: Readonly<Record<string, string>> | undefined;
    timeoutMs: number | undefined;
  }>;
  stdin: Map<string, string>;
  /** Agent binaries whose installer exits non-zero. */
  brokenInstallers: Set<string>;
  respond: (argv: ReadonlyArray<string>) => Ran | undefined;
  nextPid: number;
  host: Host["Service"];
};

const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });
const fail = (code = 1, stderr = ""): Ran => ({ code, stdout: "", stderr });

const installerScript = (bin: string) => `#!/bin/bash\n# installs ${bin}\n`;

const writeBin = (dir: string, bin: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, bin), "");
};

export const SELF = ["/opt/bun", "/opt/devbox/apps/cli/src/cli.ts"] as const;

export const makeMachine = (overrides: Partial<FakeMachine> = {}): FakeMachine => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "devbox-machine-")));
  const home = join(base, "home");
  const etc = join(base, "etc");
  mkdirSync(join(etc, "profile.d"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const m: FakeMachine = {
    base,
    home,
    etc,
    sudo: false,
    systemd: false,
    userBus: false,
    linger: false,
    latest: "0.2.0",
    git: new Map(),
    units: new Map(),
    processes: [],
    binaries: new Set(["npm"]),
    calls: [],
    probes: [],
    pages: new Map(),
    fetches: [],
    posts: [],
    webhookUp: true,
    answerPost: () => undefined,
    answer: () => undefined,
    requests: [],
    platform: "linux",
    vitals: {
      load: 0.25,
      memory: { used: 2_000_000_000, total: 8_000_000_000 },
      disk: { used: 30_000_000_000, total: 100_000_000_000 },
    },
    vitalsAsked: [],
    runs: [],
    stdin: new Map(),
    brokenInstallers: new Set(),
    respond: () => undefined,
    nextPid: 4000,
    ...overrides,
  } as FakeMachine;

  const run = (
    argv: ReadonlyArray<string>,
    stdin?: string,
    env: Readonly<Record<string, string>> = {},
  ): Ran => {
    const custom = m.respond(argv);
    if (custom) return custom;
    const [cmd, ...rest] = argv;
    const sudo = cmd === "sudo" && rest[0] === "-n";
    const bin = (sudo ? rest[1] : cmd)?.split("/").at(-1);
    const args = sudo ? rest.slice(2) : rest;
    if (sudo && !m.sudo) return fail(1, "sudo: a password is required");
    if (bin === "true") return ok();
    if (bin === "curl") {
      const url = args.at(-1);
      const agent = AGENTS.find((a) => a.install._tag === "Script" && a.install.url === url);
      return agent ? ok(installerScript(agent.bin)) : fail(22, `fake host: no ${url}`);
    }
    if (bin === "setsid") return run(args, stdin, env);
    if (bin === "bash") {
      const installs = /# installs (\S+)/.exec(stdin ?? "")?.[1];
      if (installs === undefined || env.HOME === undefined) return fail(1, "fake host: bash");
      if (m.brokenInstallers.has(installs)) return fail(1, `${installs}: install failed`);
      writeBin(join(env.HOME, ".local", "bin"), installs);
      return installs === "devin" ? fail(1, "Error: Login canceled") : ok();
    }
    if (bin === "tee") {
      mkdirSync(dirname(args[0]!), { recursive: true });
      writeFileSync(args[0]!, stdin ?? "");
      return ok(stdin);
    }
    if (bin === "git" && args[0] === "config") {
      const [, , op, key, value] = args;
      const values = m.git.get(key!) ?? [];
      if (op === "--get-all")
        return values.length === 0 ? fail(1) : ok(values.map((v) => `${v}\n`).join(""));
      if (op === "--unset-all") return m.git.delete(key!) ? ok() : fail(5);
      if (op === "--add") return (m.git.set(key!, [...values, value!]), ok());
    }
    if (bin === "npm" && args[0] === "view")
      return m.latest === undefined ? fail(1) : ok(`${m.latest}\n`);
    if (bin === "npm" && args[0] === "install") {
      const prefix = args[args.indexOf("--prefix") + 1]!;
      const target = args.at(-1)!;
      const agent = AGENTS.find(
        (a) => a.install._tag === "Npm" && target === `${a.install.pkg}@latest`,
      );
      if (agent) {
        if (m.brokenInstallers.has(agent.bin)) return fail(1, `${agent.bin}: install failed`);
        writeBin(join(prefix, "bin"), agent.bin);
        return ok();
      }
      const version = target.replace(/^t3@/, "");
      const pkg = join(prefix, "lib", "node_modules", "t3", "package.json");
      mkdirSync(dirname(pkg), { recursive: true });
      writeFileSync(pkg, JSON.stringify({ name: "t3", version }));
      return ok();
    }
    if (bin === "systemctl") {
      const user = args[0] === "--user";
      const [verb, unit] = user ? args.slice(1) : args;
      if (verb === "show-environment") return m.userBus ? ok("PATH=/usr/bin\n") : fail(1);
      const key = `${user ? "user" : "system"}:${unit}`;
      const state = m.units.get(key) ?? { active: false, enabled: false };
      if (verb === "is-active") return ok(state.active ? "active\n" : "inactive\n");
      if (verb === "is-enabled") return ok(state.enabled ? "enabled\n" : "disabled\n");
      if (verb === "daemon-reload") return ok();
      if (verb === "enable") return (m.units.set(key, { ...state, enabled: true }), ok());
      if (verb === "restart") return (m.units.set(key, { ...state, active: true }), ok());
      if (verb === "disable") {
        m.units.set(`${user ? "user" : "system"}:${args.at(-1)}`, {
          active: false,
          enabled: false,
        });
        return ok();
      }
    }
    if (bin === "loginctl" && args[0] === "show-user")
      return ok(`Linger=${m.linger ? "yes" : "no"}\n`);
    if (bin === "loginctl" && args[0] === "enable-linger") return ((m.linger = true), ok());
    return fail(127, `fake host: no ${argv.join(" ")}`);
  };

  m.host = {
    hostname: "box-1.example.internal",
    user: "agent",
    etc,
    path: "/usr/bin:/bin",
    self: SELF,
    systemd: m.systemd,
    platform: m.platform,
    run: (argv, options = {}) =>
      Effect.sync(() => {
        m.calls.push(argv);
        m.runs.push({ argv, env: options.env, timeoutMs: options.timeoutMs });
        if (options.stdin !== undefined) m.stdin.set(argv.join(" "), options.stdin);
        return run(argv, options.stdin, options.env);
      }),
    which: (name) => Effect.sync(() => m.binaries.has(name)),
    processes: Effect.sync(() => [...m.processes]),
    spawnDetached: (argv) =>
      Effect.sync(() => {
        m.calls.push(["<detached>", ...argv]);
        const pid = (m.nextPid += 1);
        m.processes.push({ pid, argv });
        return pid;
      }),
    stop: (pid) =>
      Effect.sync(() => {
        m.calls.push(["<stop>", String(pid)]);
        m.processes = m.processes.filter((p) => p.pid !== pid);
      }),
    answers: (port, address) =>
      Effect.sync(() => {
        m.probes.push({ address, port });
        return (
          m.processes.some((p) => p.argv.includes("serve")) ||
          [...m.units.values()].some((u) => u.active)
        );
      }),
    fetchText: (url) =>
      Effect.sync(() => {
        m.fetches.push(url);
        return Option.map(Option.fromUndefinedOr(m.pages.get(url)), (body) => ({ body, ms: 12 }));
      }),
    post: (url, message) =>
      Effect.sync(() => {
        const posted = { url, ...message };
        m.posts.push(posted);
        const answered = m.answerPost(posted) ?? m.webhookUp;
        if (answered === false) return Option.none();
        return Option.some(answered === true ? "" : answered);
      }),
    request: (url, request) =>
      Effect.sync(() => {
        m.requests.push({ url, ...request });
        return Option.fromUndefinedOr(m.answer(url, request));
      }),
    vitals: (dir) =>
      Effect.sync(() => {
        m.vitalsAsked.push(dir);
        return m.vitals;
      }),
    readLine: Effect.sync(() => {
      m.calls.push(["<enter>"]);
      return "";
    }),
  };
  return m;
};
