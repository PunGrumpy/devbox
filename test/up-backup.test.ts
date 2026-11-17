import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envFile } from "./support/backup.ts";
import { makeMachine, SELF } from "./support/host.ts";
import { devbox } from "./support/run.ts";

type Machine = ReturnType<typeof makeMachine>;

const up = (m: Machine, ...args: Array<string>) =>
  devbox({ HOME: m.home, PATH: "/usr/bin:/bin" }, ["up", ...args], { host: m.host });

const MUTATING =
  /^(<detached>|<stop>|tee|npm install|apt-get|git config --global (--add|--unset-all)|systemctl (enable|restart|daemon-reload)|loginctl enable-linger)/;
const mutations = (m: Machine, from: number) =>
  m.calls
    .slice(from)
    .map((argv) =>
      argv.filter((a) => a !== "sudo" && a !== "-n" && a !== "--user" && a !== "env").join(" "),
    )
    .filter((line) => MUTATING.test(line));

const withTools = (m: Machine) => {
  m.binaries.add("restic");
  m.binaries.add("sqlite3");
  m.binaries.add("apt-get");
};

const ENABLED = "RESTIC_REPOSITORY=/srv/restic-repo\nRESTIC_PASSWORD=x\n";

describe("devbox up and backups", () => {
  test("without an env file it says backups are off and how to turn them on", async () => {
    const m = makeMachine({ userBus: true });
    withTools(m);
    const r = await up(m);
    expect(r.code).toBe(0);
    const lines = r.err.split("\n").filter((line) => line.includes("backups"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("skipped backups: off");
    expect(lines[0]).toContain("devbox backup sources");
    expect(lines[0]).toContain(`${m.home}/.config/devbox/backup/env`);
    expect(lines[0]).toContain("RESTIC_REPOSITORY");
    expect(existsSync(join(m.home, ".config/systemd/user/devbox-backup.timer"))).toBe(false);
    expect(m.calls.some((c) => c.includes("devbox-backup.timer"))).toBe(false);
  });

  test("an env file whose RESTIC_REPOSITORY is empty keeps backups off", async () => {
    const m = makeMachine({ userBus: true });
    withTools(m);
    envFile(m.home, "RESTIC_REPOSITORY=\nAWS_DEFAULT_REGION=auto\n");
    const r = await up(m);
    expect(r.err).toContain("skipped backups: off");
    expect(existsSync(join(m.home, ".config/systemd/user/devbox-backup.service"))).toBe(false);
  });

  test("with a repository set it installs a nightly user timer and a oneshot service that executes `backup run`", async () => {
    const m = makeMachine({ userBus: true });
    withTools(m);
    envFile(m.home, ENABLED);
    const r = await up(m);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("backups: off");
    const dir = join(m.home, ".config/systemd/user");
    const service = readFileSync(join(dir, "devbox-backup.service"), "utf8");
    expect(service).toContain("Type=oneshot\n");
    expect(service).toContain(`ExecStart=${SELF.join(" ")} backup run\n`);
    expect(service).toContain("Nice=10\n");
    expect(service).not.toContain("User=");
    expect(service).not.toContain("EnvironmentFile");
    const timer = readFileSync(join(dir, "devbox-backup.timer"), "utf8");
    expect(timer).toContain("OnCalendar=*-*-* 03:30 Asia/Bangkok\n");
    expect(timer).toContain("RandomizedDelaySec=20m\n");
    expect(timer).toContain("Persistent=true\n");
    expect(timer).toContain("WantedBy=timers.target\n");
    expect(m.units.get("user:devbox-backup.timer")).toEqual({ active: true, enabled: true });
    expect(m.linger).toBe(true);
    expect(r.err).toContain("enabled devbox-backup.timer, daily at 03:30 Asia/Bangkok");
  });

  test("a second run changes nothing", async () => {
    const m = makeMachine({ userBus: true });
    withTools(m);
    envFile(m.home, ENABLED);
    await up(m);
    const before = m.calls.length;
    const second = await up(m);
    expect(second.err).toContain("No changes.");
    expect(mutations(m, before)).toEqual([]);
  });

  test("a timer that was stopped is enabled again, and only that", async () => {
    const m = makeMachine({ userBus: true });
    withTools(m);
    envFile(m.home, ENABLED);
    await up(m);
    m.units.set("user:devbox-backup.timer", { active: false, enabled: false });
    const before = m.calls.length;
    const again = await up(m);
    expect(mutations(m, before)).toEqual([
      "systemctl daemon-reload",
      "systemctl enable devbox-backup.timer",
      "systemctl restart devbox-backup.timer",
    ]);
    expect(again.err).toContain("enabled devbox-backup.timer");
  });

  test("with systemd and sudo the pair is a system unit that runs as this user", async () => {
    const m = makeMachine({ systemd: true, sudo: true });
    withTools(m);
    envFile(m.home, ENABLED);
    const r = await up(m);
    expect(r.code).toBe(0);
    const service = readFileSync(join(m.etc, "systemd/system/devbox-backup.service"), "utf8");
    expect(service).toContain("User=agent\n");
    expect(existsSync(join(m.etc, "systemd/system/devbox-backup.timer"))).toBe(true);
    expect(m.calls).toContainEqual(["sudo", "-n", "systemctl", "enable", "devbox-backup.timer"]);
    expect(m.units.get("system:devbox-backup.timer")).toEqual({ active: true, enabled: true });
    const before = m.calls.length;
    expect((await up(m)).err).toContain("No changes.");
    expect(mutations(m, before)).toEqual([]);
  });

  test("missing restic and sqlite3 are installed with apt when sudo works", async () => {
    const m = makeMachine({ systemd: true, sudo: true });
    m.binaries.add("apt-get");
    envFile(m.home, ENABLED);
    m.respond = (argv) => {
      if (argv.includes("apt-get") && argv.includes("install")) {
        m.binaries.add("restic");
        m.binaries.add("sqlite3");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv.includes("apt-get")) return { code: 0, stdout: "", stderr: "" };
      return undefined;
    };
    const r = await up(m);
    expect(r.code).toBe(0);
    expect(m.calls).toContainEqual([
      "sudo",
      "-n",
      "env",
      "DEBIAN_FRONTEND=noninteractive",
      "apt-get",
      "install",
      "-y",
      "-qq",
      "--no-install-recommends",
      "restic",
      "sqlite3",
    ]);
    expect(r.err).toContain("installed restic and sqlite3 with apt");
    const before = m.calls.length;
    await up(m);
    expect(mutations(m, before)).toEqual([]);
  });

  test("only the missing package is installed", async () => {
    const m = makeMachine({ systemd: true, sudo: true });
    m.binaries.add("apt-get");
    m.binaries.add("restic");
    envFile(m.home, ENABLED);
    m.respond = (argv) =>
      argv.includes("apt-get") ? { code: 0, stdout: "", stderr: "" } : undefined;
    await up(m);
    expect(m.calls.find((c) => c.includes("apt-get") && c.includes("install"))?.slice(-1)).toEqual([
      "sqlite3",
    ]);
  });

  test("without passwordless sudo it leaves the timer out and says why", async () => {
    const m = makeMachine({ userBus: true });
    m.binaries.add("apt-get");
    envFile(m.home, ENABLED);
    const r = await up(m);
    expect(r.code).toBe(0);
    expect(r.err).toContain(
      "skipped backup timer: restic and sqlite3 missing, and apt with passwordless sudo is needed to install them",
    );
    expect(existsSync(join(m.home, ".config/systemd/user/devbox-backup.timer"))).toBe(false);
  });

  test("without systemd the detached supervisor gets a note instead of a timer", async () => {
    const m = makeMachine();
    withTools(m);
    envFile(m.home, ENABLED);
    const r = await up(m, "--supervisor", "detached");
    expect(r.code).toBe(0);
    expect(r.err).toContain("skipped backup timer: no systemd here");
    expect(m.calls.some((c) => c.includes("devbox-backup.timer"))).toBe(false);
  });
});
