import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { publicKeyOf } from "../src/spoke/signed.ts";
import { makeMachine, SELF } from "./support/host.ts";
import { devbox } from "./support/run.ts";

const KEY_A = publicKeyOf(generateKeyPairSync("ed25519").privateKey);
const KEY_B = publicKeyOf(generateKeyPairSync("ed25519").privateKey);

const up = (m: ReturnType<typeof makeMachine>, ...args: string[]) =>
  devbox({ HOME: m.home, PATH: "/usr/bin:/bin" }, ["up", ...args], {
    host: m.host,
  });

const unitPath = (m: ReturnType<typeof makeMachine>) =>
  join(m.home, ".config/systemd/user/devbox-spoke.service");

const recorded = (m: ReturnType<typeof makeMachine>) =>
  JSON.parse(readFileSync(join(m.home, ".config/devbox/machine.json"), "utf-8"))
    .up;

describe("devbox up --spoke", () => {
  test("keeps the spoke running on loopback, and then has nothing to do", async () => {
    const m = makeMachine({ userBus: true });
    const first = await up(m, "--spoke");
    expect(first.code).toBe(0);
    const unit = readFileSync(unitPath(m), "utf-8");
    expect(unit).toContain(
      `ExecStart=${SELF.join(" ")} spoke --host 127.0.0.1 --port 3782\n`
    );
    expect(unit).toContain("KillMode=process\n");
    expect(unit).toContain("Restart=always");
    expect(m.units.get("user:devbox-spoke.service")).toEqual({
      active: true,
      enabled: true,
    });
    expect(first.err).toContain(
      "enabled devbox-spoke.service on 127.0.0.1:3782"
    );
    expect((await up(m, "--spoke")).err).toContain("No changes.");
  });

  test("trusts each --trust key, listens on --host, and records the flags for an update", async () => {
    const m = makeMachine({ userBus: true });

    const r = await up(
      m,
      "--spoke",
      "--host",
      "100.64.0.21",
      "--trust",
      KEY_A,
      "--trust",
      KEY_B
    );

    expect(r.code).toBe(0);
    expect(readFileSync(unitPath(m), "utf-8")).toContain(
      `spoke --host 100.64.0.21 --port 3782 --trust ${KEY_A} --trust ${KEY_B}\n`
    );
    expect(recorded(m)).toEqual([
      "--data",
      m.home,
      "--port",
      "3773",
      "--base-dir",
      `${m.home}/.t3`,
      "--workspace",
      m.home,
      "--host",
      "100.64.0.21",
      "--name",
      "box-1.example.internal",
      "--channel",
      "nightly",
      "--supervisor",
      "auto",
      "--spoke",
      "--trust",
      KEY_A,
      "--trust",
      KEY_B,
    ]);
  });

  test("the recorded flags set the machine up the same way again", async () => {
    const m = makeMachine({ userBus: true });
    await up(m, "--spoke", "--trust", KEY_A, "--name", "edge-7", "--no-setup");
    const again = await up(m, ...recorded(m));
    expect(again.code).toBe(0);
    expect(again.err).toContain("No changes.");
  });

  test("another key restarts the spoke with it", async () => {
    const m = makeMachine({ userBus: true });
    await up(m, "--spoke", "--trust", KEY_A);
    m.units.set("user:devbox-spoke.service", { active: true, enabled: true });
    const second = await up(m, "--spoke", "--trust", KEY_B);
    expect(second.err).toContain("enabled devbox-spoke.service");
    expect(readFileSync(unitPath(m), "utf-8")).not.toContain(KEY_A);
  });

  test("without --spoke it stops the spoke and removes its unit", async () => {
    const m = makeMachine({ userBus: true });
    await up(m, "--spoke");
    const second = await up(m);
    expect(second.code).toBe(0);
    expect(second.err).toContain("removed devbox-spoke.service");
    expect(existsSync(unitPath(m))).toBe(false);
    expect(m.units.get("user:devbox-spoke.service")).toEqual({
      active: false,
      enabled: false,
    });
    expect((await up(m)).err).toContain("No changes.");
  });

  test("--trust without --spoke is a usage error", async () => {
    const m = makeMachine({ userBus: true });
    const r = await up(m, "--trust", KEY_A);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--trust needs --spoke");
  });

  test("--trust takes only a hub key", async () => {
    const r = await up(
      makeMachine({ userBus: true }),
      "--spoke",
      "--trust",
      "edge-7"
    );

    expect(r.code).not.toBe(0);
    expect(r.err).toContain("devbox hub key");
  });

  test("without systemd it says to run the spoke yourself", async () => {
    const r = await up(makeMachine(), "--spoke");
    expect(r.code).toBe(0);
    expect(r.err).toContain("no systemd here, run `devbox spoke` yourself");
  });
});
