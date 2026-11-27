import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL = join(import.meta.dir, "..", "..", "..", "install.sh");

// Runs install.sh with only stub commands on PATH. The stub bash fails, so the script stops
// right after it would have run bun's installer.
const run = (stubs: { present: ReadonlyArray<string>; sudo?: boolean; uid?: string }) => {
  const dir = mkdtempSync(join(tmpdir(), "devbox-install-"));
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const record = (name: string) => `echo "${name} $*" >>'${log}'`;
  for (const name of stubs.present) stub(name, record(name));
  stub("id", `echo ${stubs.uid ?? "1000"}`);
  stub("env", record("env"));
  stub("curl", record("curl"));
  stub("bash", `${record("bash")}\nexit 1`);
  if (stubs.sudo !== undefined)
    stub("sudo", `${record("sudo")}\n${stubs.sudo ? "exit 0" : "exit 1"}`);
  const ran = Bun.spawnSync(["/bin/sh", INSTALL], {
    env: { PATH: bin, HOME: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const calls = (() => {
    try {
      // curl and bash run at once in a pipeline, so their order is not fixed.
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "bash");
    } catch {
      return [];
    }
  })();
  return { code: ran.exitCode, err: ran.stderr.toString(), calls };
};

describe("install.sh before bun", () => {
  test("installs unzip with apt-get when sudo works, then runs bun's installer", () => {
    const r = run({ present: ["apt-get"], sudo: true });
    expect(r.err).toContain("installing unzip with apt-get");
    expect(r.calls).toEqual([
      "sudo -n true",
      "sudo -n apt-get update -qq",
      "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends unzip",
      "curl -fsSL https://bun.sh/install",
    ]);
  });

  test("tells an admin the command when sudo needs a password, and does not touch bun", () => {
    const r = run({ present: ["apt-get"], sudo: false });
    expect(r.code).toBe(1);
    expect(r.err).toContain("unzip is required to install bun");
    expect(r.err).toContain("sudo apt-get install -y unzip");
    expect(r.calls).toEqual(["sudo -n true"]);
  });

  test("tells an admin when there is no sudo at all", () => {
    const r = run({ present: ["apt-get"] });
    expect(r.code).toBe(1);
    expect(r.err).toContain("sudo apt-get install -y unzip");
    expect(r.calls).toEqual([]);
  });

  test("without apt-get it names the package instead of a command that cannot work", () => {
    const r = run({ present: [], sudo: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain("install the unzip package");
    expect(r.err).not.toContain("apt-get install");
  });

  test("as root it needs no sudo", () => {
    const r = run({ present: ["apt-get"], uid: "0" });
    expect(r.calls).toEqual([
      "apt-get update -qq",
      "env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends unzip",
      "curl -fsSL https://bun.sh/install",
    ]);
  });

  test("with unzip present it goes straight to bun's installer", () => {
    const r = run({ present: ["unzip", "apt-get"], sudo: true });
    expect(r.calls).toEqual(["curl -fsSL https://bun.sh/install"]);
  });

  test("with bun present it checks nothing", () => {
    const r = run({ present: ["bun"] });
    expect(r.err).not.toContain("unzip is required");
    expect(r.calls.some((c) => c.startsWith("curl"))).toBe(false);
  });
});
