import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { makeMachine, SELF } from "./support/host.ts";
import { devbox } from "./support/run.ts";

const up = (m: ReturnType<typeof makeMachine>, ...args: Array<string>) =>
  devbox({ HOME: m.home, PATH: "/usr/bin:/bin" }, ["up", ...args], { host: m.host });

const MUTATING =
  /^(<detached>|<stop>|tee|npm install|git config --global (--add|--unset-all)|systemctl (enable|restart|daemon-reload)|loginctl enable-linger)/;
const mutations = (m: ReturnType<typeof makeMachine>, from: number) =>
  m.calls
    .slice(from)
    .map((argv) => argv.filter((a) => a !== "sudo" && a !== "-n" && a !== "--user").join(" "))
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
    expect(JSON.parse(readFileSync(join(m.home, ".config/devbox/machine.json"), "utf8"))).toEqual({
      name: "box-1.example.internal",
      port: 3773,
      baseDir: `${m.home}/.t3`,
      t3: `${m.home}/.local/bin/t3`,
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
      "--no-setup",
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
    expect(JSON.parse(readFileSync(join(m.home, ".config/devbox/machine.json"), "utf8")).url).toBe(
      "https://edge-7.example.com",
    );
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
    expect(second.err).toContain("No changes. T3 Code answers on http://127.0.0.1:3773");
    expect(mutations(m, before)).toEqual([]);
    expect(m.processes).toHaveLength(1);
  });

  test("it writes the name, the profile and git as one list of settings when sudo works", async () => {
    const m = makeMachine({ sudo: true });
    writeFileSync(join(m.etc, "machine-info"), "PRETTY_HOSTNAME=old\nCHASSIS=vm\n");
    await up(m, "--supervisor", "detached", "--name", "edge-7");
    expect(readFileSync(join(m.etc, "machine-info"), "utf8")).toBe(
      "PRETTY_HOSTNAME=edge-7\nCHASSIS=vm\n",
    );
    const profile = readFileSync(join(m.etc, "profile.d/devbox.sh"), "utf8");
    expect(profile).toContain(`export CLAUDE_CONFIG_DIR='${m.home}/.claude'`);
    expect(profile).toContain(
      `export PATH='${m.home}/.local/bin':'${m.home}/.local/share/mise/shims':"$PATH"`,
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
    expect(r.err).toContain(`skipped ${m.etc}/machine-info: no passwordless sudo`);
    expect(r.err).toContain(`skipped ${m.etc}/profile.d/devbox.sh: no passwordless sudo`);
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
    expect(updated.err).toContain("started T3 Code, because T3 Code was updated");
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
    expect(r.err).toContain("skipped t3@nightly: npm did not answer, keeping 0.2.0");
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
    const unit = readFileSync(join(m.home, ".config/systemd/user/devbox.service"), "utf8");
    expect(unit).toContain(
      `ExecStart=/opt/bun /opt/devbox/src/cli.ts serve --data ${m.home} --port 3773 --base-dir ${m.home}/.t3 --workspace ${m.home} --public-url https://edge-7.example.com\n`,
    );
    expect(unit).toContain("Environment=PATH=/usr/bin:/bin\n");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toContain("User=");
    expect(m.linger).toBe(true);
    expect(m.units.get("user:devbox.service")).toEqual({ active: true, enabled: true });

    const before = m.calls.length;
    expect((await up(m, "--public-url", "https://edge-7.example.com")).err).toContain(
      "No changes.",
    );
    expect(mutations(m, before)).toEqual([]);
  });

  test("with systemd and sudo it installs a system unit for this user", async () => {
    const m = makeMachine({ systemd: true, sudo: true });
    const r = await up(m);
    expect(r.code).toBe(0);
    const unit = readFileSync(join(m.etc, "systemd/system/devbox.service"), "utf8");
    expect(unit).toContain("User=agent\n");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(m.calls).toContainEqual(["sudo", "-n", "systemctl", "restart", "devbox.service"]);
  });

  test("on a machine whose $HOME does not survive, agent folders and a saved gh login live in --data", async () => {
    const m = makeMachine();
    const data = join(m.base, "persist");
    mkdirSync(join(data, ".config/gh"), { recursive: true });
    writeFileSync(join(data, ".config/gh/hosts.yml"), "github.com: {}\n");
    mkdirSync(join(m.home, ".config/gh"), { recursive: true });
    await up(m, "--supervisor", "detached", "--data", data);
    expect(readlinkSync(join(m.home, ".agents"))).toBe(join(data, ".agents"));
    expect(readlinkSync(join(m.home, ".config/gh"))).toBe(join(data, ".config/gh"));
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
    expect(readFileSync(join(data, ".agents/skills/tdd/SKILL.md"), "utf8")).toBe("keep me\n");
  });

  test("it refuses to link when $HOME and --data both hold agent files, and deletes neither", async () => {
    const m = makeMachine();
    const data = join(m.base, "persist");
    mkdirSync(join(m.home, ".agents"), { recursive: true });
    writeFileSync(join(m.home, ".agents/home.md"), "home\n");
    mkdirSync(join(data, ".agents"), { recursive: true });
    writeFileSync(join(data, ".agents/data.md"), "data\n");
    const r = await up(m, "--supervisor", "detached", "--data", data);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("both hold files");
    expect(readFileSync(join(m.home, ".agents/home.md"), "utf8")).toBe("home\n");
    expect(readFileSync(join(data, ".agents/data.md"), "utf8")).toBe("data\n");
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
    expect(m.calls.some((c) => c[0]?.endsWith("/mise") && c.includes("node@lts"))).toBe(true);
    expect(m.calls.some((c) => c[0] === shim && c[1] === "install")).toBe(true);
    expect(r.code).toBe(0);
  });

  test("before installing Node it adds libatomic1 when dpkg says it is missing", async () => {
    const m = makeMachine({ binaries: new Set(), sudo: true });
    m.respond = (argv) =>
      argv[0] === "dpkg" ? { code: 1, stdout: "", stderr: "not installed" } : undefined;
    await up(m, "--supervisor", "detached");
    expect(m.calls).toContainEqual(["sudo", "-n", "apt-get", "install", "-y", "-qq", "libatomic1"]);
  });
});
