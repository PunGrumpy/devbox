import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { Option } from "effect";

import { t3Bind } from "../src/machine/serve.ts";
import { absolutePath } from "../src/migrate/paths.ts";
import { makeMachine, SELF } from "./support/host.ts";
import { devbox } from "./support/run.ts";

const up = (m: ReturnType<typeof makeMachine>, ...args: Array<string>) =>
  devbox({ HOME: m.home, PATH: "/usr/bin:/bin" }, ["up", ...args], {
    host: m.host,
  });

const MUTATING =
  /^(<detached>|<stop>|tee|npm install|git config --global (--add|--unset-all)|systemctl (enable|restart|daemon-reload)|loginctl enable-linger)/;
const mutations = (m: ReturnType<typeof makeMachine>, from: number) =>
  m.calls
    .slice(from)
    .map((argv) =>
      argv.filter((a) => a !== "sudo" && a !== "-n" && a !== "--user").join(" ")
    )
    .filter((line) => MUTATING.test(line));

describe("flags become one machine config", () => {
  test("defaults come from the hostname and $HOME", async () => {
    const m = makeMachine();
    const r = await up(m, "--supervisor", "detached");
    expect(r.code).toBe(0);
    expect(r.err).toContain(`name        box-1.example.internal`);
    expect(r.err).toContain(`data        ${m.home}`);
    expect(r.err).toContain(`base dir    ${m.home}/.t3`);
    expect(r.err).toContain("port        3773");
    expect(r.err).toContain("channel     nightly");
    expect(
      JSON.parse(
        readFileSync(join(m.home, ".config/devbox/machine.json"), "utf8")
      )
    ).toEqual({
      name: "box-1.example.internal",
      port: 3773,
      data: m.home,
      baseDir: `${m.home}/.t3`,
      t3: `${m.home}/.local/bin/t3`,
      up: [
        "--data",
        m.home,
        "--port",
        "3773",
        "--base-dir",
        `${m.home}/.t3`,
        "--workspace",
        m.home,
        "--name",
        "box-1.example.internal",
        "--channel",
        "nightly",
        "--supervisor",
        "detached",
      ],
    });
  });

  test("every machine fact is a flag, and the serve process gets them", async () => {
    const m = makeMachine();
    const data = join(m.base, "persist");
    const r = await up(
      m,
      "--supervisor",
      "detached",
      "--name",
      "edge-7",
      "--data",
      data,
      "--public-url",
      "https://edge-7.example.com/",
      "--port",
      "3799",
      "--channel",
      "latest",
      "--no-setup"
    );
    expect(r.code).toBe(0);
    expect(m.calls).toContainEqual(["npm", "view", "t3@latest", "version"]);
    expect(m.processes.map((p) => p.argv)).toEqual([
      [
        ...SELF,
        "serve",
        "--data",
        data,
        "--port",
        "3799",
        "--base-dir",
        `${data}/.t3`,
        "--workspace",
        data,
        "--public-url",
        "https://edge-7.example.com",
        "--no-setup",
      ],
    ]);
    expect(
      JSON.parse(
        readFileSync(join(m.home, ".config/devbox/machine.json"), "utf8")
      ).url
    ).toBe("https://edge-7.example.com");
    expect(r.err).toContain("T3 Code answers on https://edge-7.example.com");
  });

  test.each([
    [["--port", "70000"], "--port"],
    [["--name", "two words"], "--name"],
    [["--public-url", "ftp://x"], "--public-url"],
    [["--public-url", "https://x.example.com/path"], "--public-url"],
    [["--supervisor", "cron"], "--supervisor"],
  ])("rejects %p with exit 2", async (args, flag) => {
    const m = makeMachine();
    const r = await up(m, ...args);
    expect(r.code).toBe(2);
    expect(r.err).toContain(flag);
    expect(m.calls).toEqual([]);
  });
});

describe("linked environments", () => {
  const settingsFile = (m: ReturnType<typeof makeMachine>) =>
    join(m.home, ".t3/userdata/settings.json");

  test("a new box gets a private settings.json that turns it on, and a rerun changes nothing", async () => {
    const m = makeMachine();
    const first = await up(m, "--supervisor", "detached");
    expect(first.err).toContain(`wrote ${settingsFile(m)}`);
    expect(JSON.parse(readFileSync(settingsFile(m), "utf8"))).toEqual({
      linkedEnvironmentsEnabled: true,
    });
    expect(statSync(settingsFile(m)).mode & 0o777).toBe(0o600);

    const before = m.calls.length;
    const second = await up(m, "--supervisor", "detached");
    expect(second.err).toContain("No changes.");
    expect(mutations(m, before)).toEqual([]);
  });

  test("it keeps every other key and the file's mode when it turns the setting on", async () => {
    const m = makeMachine();
    mkdirSync(dirname(settingsFile(m)), { recursive: true });
    writeFileSync(
      settingsFile(m),
      JSON.stringify({
        guestSharingEnabled: true,
        linkedEnvironmentsEnabled: false,
        nested: { a: [1] },
      }),
      { mode: 0o644 }
    );
    const r = await up(m, "--supervisor", "detached");
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile(m), "utf8"))).toEqual({
      guestSharingEnabled: true,
      linkedEnvironmentsEnabled: true,
      nested: { a: [1] },
    });
    expect(statSync(settingsFile(m)).mode & 0o777).toBe(0o644);
  });

  test("a setting that is already on is left byte for byte as it is", async () => {
    const m = makeMachine();
    mkdirSync(dirname(settingsFile(m)), { recursive: true });
    const text = '{"linkedEnvironmentsEnabled":true,   "a": 1}';
    writeFileSync(settingsFile(m), text);
    const r = await up(m, "--supervisor", "detached");
    expect(readFileSync(settingsFile(m), "utf8")).toBe(text);
    expect(r.err).not.toContain("settings.json");
  });

  test.each([
    ["an array", "[1]"],
    ["null", "null"],
    ["invalid JSON", "{ // comment\n}"],
    ["empty", ""],
  ])(
    "when settings.json is %s it skips with a note and does not overwrite it",
    async (_, text) => {
      const m = makeMachine();
      mkdirSync(dirname(settingsFile(m)), { recursive: true });
      writeFileSync(settingsFile(m), text);
      const r = await up(m, "--supervisor", "detached");
      expect(r.code).toBe(0);
      expect(r.err).toContain(`skipped ${settingsFile(m)}: not a JSON object`);
      expect(readFileSync(settingsFile(m), "utf8")).toBe(text);
    }
  );

  test("it follows --base-dir", async () => {
    const m = makeMachine();
    const baseDir = join(m.base, "t3-home");
    await up(m, "--supervisor", "detached", "--base-dir", baseDir);
    expect(
      JSON.parse(readFileSync(join(baseDir, "userdata/settings.json"), "utf8"))
    ).toEqual({
      linkedEnvironmentsEnabled: true,
    });
  });

  test("a running T3 reads it from the file, so the change does not restart it", async () => {
    const m = makeMachine();
    await up(m, "--supervisor", "detached");
    const [first] = m.processes;
    writeFileSync(settingsFile(m), '{"linkedEnvironmentsEnabled": false}');
    const r = await up(m, "--supervisor", "detached");
    expect(r.err).toContain(`wrote ${settingsFile(m)}`);
    expect(r.err).not.toContain("started T3 Code");
    expect(m.processes.map((p) => p.pid)).toEqual([first!.pid]);
  });
});

describe("--host", () => {
  const TAILNET = "100.64.0.7";

  test("T3 listens on every interface unless told otherwise, and the probe uses loopback", async () => {
    const m = makeMachine();
    const r = await up(m, "--supervisor", "detached");
    expect(r.code).toBe(0);
    expect(m.processes[0]!.argv).not.toContain("--host");
    expect(m.probes.at(-1)).toEqual({ address: "127.0.0.1", port: 3773 });
    expect(r.err).toContain("host        0.0.0.0");
    expect(
      JSON.parse(
        readFileSync(join(m.home, ".config/devbox/machine.json"), "utf8")
      )
    ).not.toHaveProperty("host");
  });

  test("it reaches serve, the unit file and machine.json, and the probe knocks on that address", async () => {
    const m = makeMachine({ userBus: true });
    const r = await up(m, "--host", TAILNET);
    expect(r.code).toBe(0);
    const unit = readFileSync(
      join(m.home, ".config/systemd/user/devbox.service"),
      "utf8"
    );
    expect(unit).toContain(
      `--port 3773 --base-dir ${m.home}/.t3 --workspace ${m.home} --host ${TAILNET}\n`
    );
    expect(
      JSON.parse(
        readFileSync(join(m.home, ".config/devbox/machine.json"), "utf8")
      ).host
    ).toBe(TAILNET);
    expect(m.probes.at(-1)).toEqual({ address: TAILNET, port: 3773 });
    expect(r.err).toContain(`T3 Code answers on http://${TAILNET}:3773`);

    const before = m.calls.length;
    expect((await up(m, "--host", TAILNET)).err).toContain("No changes.");
    expect(mutations(m, before)).toEqual([]);
  });

  test("changing it restarts a detached serve, and going back to the default removes the flag", async () => {
    const m = makeMachine();
    await up(m, "--supervisor", "detached");
    const moved = await up(m, "--supervisor", "detached", "--host", TAILNET);
    expect(moved.err).toContain("because its flags changed");
    expect(m.processes.map((p) => p.argv.slice(-2))).toEqual([
      ["--host", TAILNET],
    ]);
    const back = await up(m, "--supervisor", "detached");
    expect(back.err).toContain("because its flags changed");
    expect(m.processes[0]!.argv).not.toContain("--host");
  });

  test("an IPv6 address is a valid host", async () => {
    const m = makeMachine();
    const r = await up(m, "--supervisor", "detached", "--host", "fd7a:115c::7");
    expect(r.code).toBe(0);
    expect(m.probes.at(-1)!.address).toBe("fd7a:115c::7");
  });

  test.each([
    [["--host", "::"], "127.0.0.1"],
    [["--host", "0.0.0.0"], "127.0.0.1"],
  ])("a wildcard %p is probed on loopback", async (args, address) => {
    const m = makeMachine();
    await up(m, "--supervisor", "detached", ...args);
    expect(m.probes.at(-1)!.address).toBe(address);
  });

  test.each([[["--host", "two words"]], [["--host", "http://x"]]])(
    "rejects %p with exit 2 before touching the machine",
    async (args) => {
      const m = makeMachine();
      const r = await up(m, ...args);
      expect(r.code).toBe(2);
      expect(r.err).toContain("--host");
      expect(m.calls).toEqual([]);
    }
  );

  test("with --public-url the proxy listens on it, so a tunnel can reach T3 at the Tailscale address", async () => {
    const m = makeMachine();
    const r = await up(
      m,
      "--supervisor",
      "detached",
      "--host",
      TAILNET,
      "--public-url",
      "https://t3-edge-7.example.com"
    );
    expect(r.code).toBe(0);
    expect(m.processes[0]!.argv.slice(-4)).toEqual([
      "--host",
      TAILNET,
      "--public-url",
      "https://t3-edge-7.example.com",
    ]);
    expect(m.probes.at(-1)).toEqual({ address: TAILNET, port: 3773 });
    expect(r.err).toContain("T3 Code answers on https://t3-edge-7.example.com");
  });

  test("T3 listens on --host, or on loopback behind the proxy", () => {
    const base = {
      data: absolutePath("/d"),
      port: 3773,
      baseDir: absolutePath("/d/.t3"),
      workspace: absolutePath("/d"),
      setup: true,
    };
    expect(t3Bind({ ...base, host: TAILNET, publicUrl: Option.none() })).toBe(
      TAILNET
    );
    expect(t3Bind({ ...base, host: "0.0.0.0", publicUrl: Option.none() })).toBe(
      "0.0.0.0"
    );
    expect(
      t3Bind({
        ...base,
        host: "0.0.0.0",
        publicUrl: Option.some("https://x.example.com"),
      })
    ).toBe("127.0.0.1");
  });
});

describe("devbox up converges", () => {
  test("a second run changes nothing and says so", async () => {
    const m = makeMachine({ sudo: true });
    const first = await up(m, "--supervisor", "detached", "--name", "edge-7");
    expect(first.code).toBe(0);
    expect(first.err).not.toContain("No changes");
    expect(mutations(m, 0).length).toBeGreaterThan(0);

    const before = m.calls.length;
    const second = await up(m, "--supervisor", "detached", "--name", "edge-7");
    expect(second.code).toBe(0);
    expect(second.err).toContain(
      "No changes. T3 Code answers on http://127.0.0.1:3773"
    );
    expect(mutations(m, before)).toEqual([]);
    expect(m.processes).toHaveLength(1);
  });

  test("it writes the name, the profile and git as one list of settings when sudo works", async () => {
    const m = makeMachine({ sudo: true });
    writeFileSync(
      join(m.etc, "machine-info"),
      "PRETTY_HOSTNAME=old\nCHASSIS=vm\n"
    );
    await up(m, "--supervisor", "detached", "--name", "edge-7");
    expect(readFileSync(join(m.etc, "machine-info"), "utf8")).toBe(
      "PRETTY_HOSTNAME=edge-7\nCHASSIS=vm\n"
    );
    const profile = readFileSync(join(m.etc, "profile.d/devbox.sh"), "utf8");
    expect(profile).toContain(`export CLAUDE_CONFIG_DIR='${m.home}/.claude'`);
    expect(profile).toContain(
      `export PATH='${m.home}/.local/bin':'${m.home}/.local/share/mise/shims':"$PATH"`
    );
    expect(profile).not.toContain("GIT_CONFIG");
    expect(m.git.get("user.name")).toEqual(["PunGrumpy"]);
    expect(m.git.get("commit.gpgsign")).toEqual(["false"]);
    expect(m.git.get("credential.https://github.com.helper")).toEqual([
      "",
      "!gh auth git-credential",
    ]);
  });

  test("without sudo it skips /etc with a note and still starts T3", async () => {
    const m = makeMachine({ sudo: false });
    const r = await up(m, "--supervisor", "detached");
    expect(r.code).toBe(0);
    expect(r.err).toContain(
      `skipped ${m.etc}/machine-info: no passwordless sudo`
    );
    expect(r.err).toContain(
      `skipped ${m.etc}/profile.d/devbox.sh: no passwordless sudo`
    );
    expect(existsSync(join(m.etc, "machine-info"))).toBe(false);
    expect(m.processes).toHaveLength(1);
  });

  test("a new release or new flags restart serve, and only then", async () => {
    const m = makeMachine();
    await up(m, "--supervisor", "detached");
    const [first] = m.processes;
    m.latest = "0.3.0";
    const updated = await up(m, "--supervisor", "detached");
    expect(updated.err).toContain("t3 0.2.0 -> 0.3.0");
    expect(updated.err).toContain(
      "started T3 Code, because T3 Code was updated"
    );
    expect(m.calls).toContainEqual(["<stop>", String(first!.pid)]);

    const moved = await up(m, "--supervisor", "detached", "--port", "3800");
    expect(moved.err).toContain("because its flags changed");
    expect(m.processes.map((p) => p.argv.at(-5))).toEqual(["3800"]);
  });

  test("npm down keeps the installed T3 and is not a change", async () => {
    const m = makeMachine();
    await up(m, "--supervisor", "detached");
    m.latest = undefined;
    const r = await up(m, "--supervisor", "detached");
    expect(r.code).toBe(0);
    expect(r.err).toContain(
      "skipped t3@nightly: npm did not answer, keeping 0.2.0"
    );
    expect(r.err).toContain("No changes.");
  });

  test("with no npm and no T3 it fails before touching anything", async () => {
    const m = makeMachine({ latest: undefined });
    const r = await up(m, "--supervisor", "detached");
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot read t3@nightly from npm");
    expect(mutations(m, 0)).toEqual([]);
  });

  test("a systemd user unit runs devbox serve and lingers", async () => {
    const m = makeMachine({ userBus: true });
    const r = await up(m, "--public-url", "https://edge-7.example.com");
    expect(r.code).toBe(0);
    expect(r.err).toContain("supervisor: systemd user unit devbox.service");
    const unit = readFileSync(
      join(m.home, ".config/systemd/user/devbox.service"),
      "utf8"
    );
    expect(unit).toContain(
      `ExecStart=/opt/bun /opt/devbox/apps/cli/src/cli.ts serve --data ${m.home} --port 3773 --base-dir ${m.home}/.t3 --workspace ${m.home} --public-url https://edge-7.example.com\n`
    );
    expect(unit).toContain(
      `Environment=PATH=${m.home}/.local/bin:${m.home}/.local/share/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n`
    );
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toContain("User=");
    expect(m.linger).toBe(true);
    expect(m.units.get("user:devbox.service")).toEqual({
      active: true,
      enabled: true,
    });

    const before = m.calls.length;
    expect(
      (await up(m, "--public-url", "https://edge-7.example.com")).err
    ).toContain("No changes.");
    expect(mutations(m, before)).toEqual([]);
  });

  test("with systemd and sudo it installs a system unit for this user", async () => {
    const m = makeMachine({ systemd: true, sudo: true });
    const r = await up(m);
    expect(r.code).toBe(0);
    const unit = readFileSync(
      join(m.etc, "systemd/system/devbox.service"),
      "utf8"
    );
    expect(unit).toContain("User=agent\n");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(m.calls).toContainEqual([
      "sudo",
      "-n",
      "systemctl",
      "restart",
      "devbox.service",
    ]);
  });

  test("on a machine whose $HOME does not survive, agent folders and a saved gh login live in --data", async () => {
    const m = makeMachine();
    const data = join(m.base, "persist");
    mkdirSync(join(data, ".config/gh"), { recursive: true });
    writeFileSync(join(data, ".config/gh/hosts.yml"), "github.com: {}\n");
    mkdirSync(join(m.home, ".config/gh"), { recursive: true });
    await up(m, "--supervisor", "detached", "--data", data);
    expect(readlinkSync(join(m.home, ".agents"))).toBe(join(data, ".agents"));
    expect(readlinkSync(join(m.home, ".config/gh"))).toBe(
      join(data, ".config/gh")
    );
    expect(lstatSync(join(data, ".agents")).isDirectory()).toBe(true);
  });

  test("moving agent folders to --data keeps the files already in $HOME", async () => {
    const m = makeMachine();
    const data = join(m.base, "persist");
    mkdirSync(join(m.home, ".agents/skills/tdd"), { recursive: true });
    writeFileSync(join(m.home, ".agents/skills/tdd/SKILL.md"), "keep me\n");
    const r = await up(m, "--supervisor", "detached", "--data", data);
    expect(r.code).toBe(0);
    expect(readlinkSync(join(m.home, ".agents"))).toBe(join(data, ".agents"));
    expect(
      readFileSync(join(data, ".agents/skills/tdd/SKILL.md"), "utf8")
    ).toBe("keep me\n");
  });

  test("when $HOME and --data both hold agent files it keeps --data and moves the other aside", async () => {
    const m = makeMachine();
    const data = join(m.base, "persist");
    mkdirSync(join(m.home, ".agents"), { recursive: true });
    writeFileSync(join(m.home, ".agents/home.md"), "home\n");
    mkdirSync(join(data, ".agents"), { recursive: true });
    writeFileSync(join(data, ".agents/data.md"), "data\n");
    const r = await up(m, "--supervisor", "detached", "--data", data);
    expect(r.code).toBe(0);
    expect(readlinkSync(join(m.home, ".agents"))).toBe(join(data, ".agents"));
    expect(readFileSync(join(data, ".agents/data.md"), "utf8")).toBe("data\n");
    const aside = readdirSync(m.home).find((name) =>
      name.startsWith(".agents.devbox-")
    );
    expect(aside).toBeDefined();
    expect(readFileSync(join(m.home, aside!, "home.md"), "utf8")).toBe(
      "home\n"
    );
  });

  test("on a machine without npm it installs Node with mise and uses that npm for T3", async () => {
    const m = makeMachine({ binaries: new Set() });
    const data = m.home;
    const shim = join(data, ".local/share/mise/shims/npm");
    m.respond = (argv) => {
      if (argv[0] === "curl" && argv.includes("https://mise.run"))
        return { code: 0, stdout: "install mise", stderr: "" };
      if (argv[0] === "sh") {
        mkdirSync(join(data, ".local/bin"), { recursive: true });
        writeFileSync(join(data, ".local/bin/mise"), "");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0]?.endsWith("/mise") && argv.includes("node@lts")) {
        mkdirSync(dirname(shim), { recursive: true });
        writeFileSync(shim, "");
        return { code: 0, stdout: "", stderr: "" };
      }
      return undefined;
    };
    const r = await up(m, "--supervisor", "detached");
    expect(
      m.calls.some((c) => c[0]?.endsWith("/mise") && c.includes("node@lts"))
    ).toBe(true);
    expect(m.calls.some((c) => c[0] === shim && c[1] === "install")).toBe(true);
    expect(r.code).toBe(0);
  });

  test("before installing Node it adds libatomic1 when dpkg says it is missing", async () => {
    const m = makeMachine({ binaries: new Set(), sudo: true });
    m.respond = (argv) =>
      argv[0] === "dpkg"
        ? { code: 1, stdout: "", stderr: "not installed" }
        : undefined;
    await up(m, "--supervisor", "detached");
    expect(m.calls).toContainEqual([
      "sudo",
      "-n",
      "apt-get",
      "install",
      "-y",
      "-qq",
      "libatomic1",
    ]);
  });

  test("an empty agent folder left in --data does not block moving the one in $HOME", async () => {
    const m = makeMachine();
    const data = join(m.base, "persist");
    mkdirSync(join(data, ".agents"), { recursive: true });
    mkdirSync(join(m.home, ".agents"), { recursive: true });
    writeFileSync(join(m.home, ".agents/home.md"), "home\n");
    const r = await up(m, "--supervisor", "detached", "--data", data);
    expect(r.code).toBe(0);
    expect(readFileSync(join(data, ".agents/home.md"), "utf8")).toBe("home\n");
  });

  test("npm runs with the mise data dir from --data", async () => {
    const m = makeMachine();
    const data = join(m.base, "persist");
    const seen: Array<string | undefined> = [];
    const host = m.host;
    m.host = {
      ...host,
      run: (argv, options) => {
        if (argv[0]?.endsWith("npm")) seen.push(options?.env?.MISE_DATA_DIR);
        return host.run(argv, options);
      },
    };
    await up(m, "--supervisor", "detached", "--data", data);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((dir) => dir === join(data, ".local/share/mise"))).toBe(
      true
    );
  });
});
