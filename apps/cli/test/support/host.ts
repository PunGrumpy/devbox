import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Option } from "effect";
import { constUndefined } from "effect/Function";

import { AGENTS } from "../../src/machine/agents.ts";
import type {
  Answer,
  Host,
  Proc,
  Ran,
  Request,
} from "../../src/machine/host.ts";
import type { Vitals } from "../../src/spoke/vitals.ts";

export interface Posted {
  readonly url: string;
  readonly body: string;
  readonly contentType: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FakeMachine {
  base: string;
  home: string;
  etc: string;
  sudo: boolean;
  systemd: boolean;
  userBus: boolean;
  linger: boolean;
  latest: string | undefined;
  git: Map<string, string[]>;
  units: Map<string, { active: boolean; enabled: boolean }>;
  processes: Proc[];
  binaries: Set<string>;
  calls: (readonly string[])[];
  probes: { readonly address: string; readonly port: number }[];
  /** URL to the body it answers with 200. Any other URL does not answer. */
  pages: Map<string, string>;
  fetches: string[];
  posts: Posted[];
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
  requests: ({ readonly url: string } & Request)[];
  platform: string;
  vitals: Vitals;
  /** The directories vitals were asked for. */
  vitalsAsked: string[];
  runs: {
    argv: readonly string[];
    env: Readonly<Record<string, string>> | undefined;
    timeoutMs: number | undefined;
  }[];
  stdin: Map<string, string>;
  /** Agent binaries whose installer exits non-zero. */
  brokenInstallers: Set<string>;
  respond: (argv: readonly string[]) => Ran | undefined;
  nextPid: number;
  host: Host["Service"];
}

const ok = (stdout = "") => ({ stdout, code: 0, stderr: "" }) satisfies Ran;

const fail = (code = 1, stderr = "") =>
  ({ code, stderr, stdout: "" }) satisfies Ran;

const installerScript = (bin: string) => `#!/bin/bash\n# installs ${bin}\n`;

const writeBin = (dir: string, bin: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, bin), "");
};

export const SELF = ["/opt/bun", "/opt/devbox/apps/cli/src/cli.ts"] as const;

type Machine = Omit<FakeMachine, "host">;

type Tool = (
  m: Machine,
  args: readonly string[],
  stdin: string | undefined,
  env: Readonly<Record<string, string>>
) => Ran | undefined;

const curl: Tool = (_, args) => {
  const url = args.at(-1);

  const agent = AGENTS.find(
    (a) => a.install._tag === "Script" && a.install.url === url
  );

  return agent
    ? ok(installerScript(agent.bin))
    : fail(22, `fake host: no ${url}`);
};

const tee: Tool = (_, args, stdin) => {
  const [file] = args;

  if (file === undefined) {
    return fail(1, "fake host: tee needs a file");
  }

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, stdin ?? "");

  return ok(stdin);
};

const bash: Tool = (m, _, stdin, env) => {
  const installs = /# installs (?<bin>\S+)/u.exec(stdin ?? "")?.groups?.bin;

  if (installs === undefined || env.HOME === undefined) {
    return fail(1, "fake host: bash");
  }

  if (m.brokenInstallers.has(installs)) {
    return fail(1, `${installs}: install failed`);
  }

  writeBin(path.join(env.HOME, ".local", "bin"), installs);

  return installs === "devin" ? fail(1, "Error: Login canceled") : ok();
};

const git: Tool = (m, args) => {
  const [sub, , op, key, value] = args;

  if (sub !== "config" || key === undefined) {
    return;
  }

  const values = m.git.get(key) ?? [];

  if (op === "--get-all") {
    return values.length === 0
      ? fail(1)
      : ok(values.map((v) => `${v}\n`).join(""));
  }

  if (op === "--unset-all") {
    return m.git.delete(key) ? ok() : fail(5);
  }

  if (op === "--add" && value !== undefined) {
    m.git.set(key, [...values, value]);

    return ok();
  }
};

const npmInstall = (m: Machine, args: readonly string[]) => {
  const prefix = args[args.indexOf("--prefix") + 1];
  const target = args.at(-1);

  if (prefix === undefined || target === undefined) {
    return fail(1, "fake host: npm install needs a prefix and a package");
  }

  const agent = AGENTS.find(
    (a) => a.install._tag === "Npm" && target === `${a.install.pkg}@latest`
  );

  if (agent) {
    if (m.brokenInstallers.has(agent.bin)) {
      return fail(1, `${agent.bin}: install failed`);
    }

    writeBin(path.join(prefix, "bin"), agent.bin);

    return ok();
  }

  const version = target.replace(/^t3@/u, "");
  const pkg = path.join(prefix, "lib", "node_modules", "t3", "package.json");
  mkdirSync(path.dirname(pkg), { recursive: true });
  writeFileSync(pkg, JSON.stringify({ name: "t3", version }));

  return ok();
};

const npm: Tool = (m, args) => {
  if (args[0] === "view") {
    return m.latest === undefined ? fail(1) : ok(`${m.latest}\n`);
  }

  if (args[0] === "install") {
    return npmInstall(m, args);
  }
};

const systemctl: Tool = (m, args) => {
  const user = args[0] === "--user";
  const scope = user ? "user" : "system";
  const [verb, unit] = user ? args.slice(1) : args;

  if (verb === "show-environment") {
    return m.userBus ? ok("PATH=/usr/bin\n") : fail(1);
  }

  const key = `${scope}:${unit}`;
  const state = m.units.get(key) ?? { active: false, enabled: false };

  if (verb === "is-active") {
    return ok(state.active ? "active\n" : "inactive\n");
  }

  if (verb === "is-enabled") {
    return ok(state.enabled ? "enabled\n" : "disabled\n");
  }

  if (verb === "daemon-reload") {
    return ok();
  }

  if (verb === "enable") {
    m.units.set(key, { ...state, enabled: true });

    return ok();
  }

  if (verb === "restart") {
    m.units.set(key, { ...state, active: true });

    return ok();
  }

  if (verb === "disable") {
    m.units.set(`${scope}:${args.at(-1)}`, {
      active: false,
      enabled: false,
    });

    return ok();
  }
};

const loginctl: Tool = (m, args) => {
  if (args[0] === "show-user") {
    return ok(`Linger=${m.linger ? "yes" : "no"}\n`);
  }

  if (args[0] === "enable-linger") {
    m.linger = true;

    return ok();
  }
};

const TOOLS = new Map<string, Tool>([
  ["true", () => ok()],
  ["curl", curl],
  ["bash", bash],
  ["tee", tee],
  ["git", git],
  ["npm", npm],
  ["systemctl", systemctl],
  ["loginctl", loginctl],
]);

export const makeMachine = (overrides: Partial<FakeMachine> = {}) => {
  const base = realpathSync(
    mkdtempSync(path.join(tmpdir(), "devbox-machine-"))
  );

  const home = path.join(base, "home");
  const etc = path.join(base, "etc");
  mkdirSync(path.join(etc, "profile.d"), { recursive: true });
  mkdirSync(home, { recursive: true });

  const machine: Machine = {
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
    answerPost: constUndefined,
    answer: constUndefined,
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
    respond: constUndefined,
    nextPid: 4000,
    ...overrides,
  };

  const run: (
    argv: readonly string[],
    stdin?: string,
    env?: Readonly<Record<string, string>>
  ) => Ran = (argv, stdin, env = {}) => {
    const custom = machine.respond(argv);

    if (custom) {
      return custom;
    }

    const [cmd, ...rest] = argv;
    const sudo = cmd === "sudo" && rest[0] === "-n";
    const bin = (sudo ? rest[1] : cmd)?.split("/").at(-1);
    const args = sudo ? rest.slice(2) : rest;

    if (sudo && !machine.sudo) {
      return fail(1, "sudo: a password is required");
    }

    if (bin === "setsid") {
      return run(args, stdin, env);
    }

    return (
      TOOLS.get(bin ?? "")?.(machine, args, stdin, env) ??
      fail(127, `fake host: no ${argv.join(" ")}`)
    );
  };

  const host: Host["Service"] = {
    etc,
    hostname: "box-1.example.internal",
    user: "agent",
    path: "/usr/bin:/bin",
    self: SELF,
    systemd: machine.systemd,
    platform: machine.platform,
    run: (argv, options = {}) =>
      Effect.sync(() => {
        machine.calls.push(argv);
        machine.runs.push({
          argv,
          env: options.env,
          timeoutMs: options.timeoutMs,
        });

        if (options.stdin !== undefined) {
          machine.stdin.set(argv.join(" "), options.stdin);
        }

        return run(argv, options.stdin, options.env);
      }),
    which: (name) => Effect.sync(() => machine.binaries.has(name)),
    processes: Effect.sync(() => [...machine.processes]),
    spawnDetached: (argv) =>
      Effect.sync(() => {
        machine.calls.push(["<detached>", ...argv]);
        machine.nextPid += 1;
        const pid = machine.nextPid;
        machine.processes.push({ pid, argv });

        return pid;
      }),
    stop: (pid) =>
      Effect.sync(() => {
        machine.calls.push(["<stop>", String(pid)]);
        machine.processes = machine.processes.filter((p) => p.pid !== pid);
      }),
    answers: (port, address) =>
      Effect.sync(() => {
        machine.probes.push({ address, port });

        return (
          machine.processes.some((p) => p.argv.includes("serve")) ||
          [...machine.units.values()].some((u) => u.active)
        );
      }),
    fetchText: (url) =>
      Effect.sync(() => {
        machine.fetches.push(url);

        return Option.map(
          Option.fromUndefinedOr(machine.pages.get(url)),
          (body) => ({ body, ms: 12 })
        );
      }),
    post: (url, message) =>
      Effect.sync(() => {
        const posted = { url, ...message };
        machine.posts.push(posted);
        const answered = machine.answerPost(posted) ?? machine.webhookUp;

        if (answered === false) {
          return Option.none();
        }

        return Option.some(answered === true ? "" : answered);
      }),
    request: (url, request) =>
      Effect.sync(() => {
        machine.requests.push({ url, ...request });

        return Option.fromUndefinedOr(machine.answer(url, request));
      }),
    vitals: (dir) =>
      Effect.sync(() => {
        machine.vitalsAsked.push(dir);

        return machine.vitals;
      }),
    readLine: Effect.sync(() => {
      machine.calls.push(["<enter>"]);

      return "";
    }),
  };

  const m: FakeMachine = Object.assign(machine, { host });

  return m;
};
