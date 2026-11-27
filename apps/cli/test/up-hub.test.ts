import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Ran } from "../src/machine/host.ts";
import { makeMachine } from "./support/host.ts";
import { devbox } from "./support/run.ts";

const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });

/**
 * A machine with a systemd user bus whose devbox is a checkout inside its own temp directory, so
 * the stamp of a build lands somewhere a test may write. `tree` is what git says `hub/` is.
 */
const machine = (options: { tree?: string; buildFails?: boolean } = {}) => {
  const m = makeMachine({ userBus: true });
  const checkout = join(m.base, "devbox");
  const state = { tree: options.tree ?? "tree-1" };
  mkdirSync(join(checkout, "apps", "hub", "out"), { recursive: true });
  m.host = {
    ...m.host,
    self: ["/opt/bun", join(checkout, "apps", "cli", "src", "cli.ts")],
  };
  m.respond = (argv) => {
    if (argv[0] === "git" && argv[3] === "rev-parse")
      return ok(`${state.tree}\n`);
    if (argv[0] === "/opt/bun" && argv[1] === "install") return ok();
    if (argv[0] === "/opt/bun" && argv[1] === "run")
      return options.buildFails ? { code: 1, stdout: "", stderr: "" } : ok();
    return undefined;
  };
  return { m, checkout, state };
};

const up = (m: ReturnType<typeof makeMachine>, ...args: Array<string>) =>
  devbox({ HOME: m.home, PATH: "/usr/bin:/bin" }, ["up", ...args], {
    host: m.host,
  });

const builds = (m: ReturnType<typeof makeMachine>, from = 0) =>
  m.calls
    .slice(from)
    .filter((argv) => argv[0] === "/opt/bun" && argv[1] === "run").length;

const unitPath = (m: ReturnType<typeof makeMachine>) =>
  join(m.home, ".config/systemd/user/devbox-hub.service");

describe("devbox up --hub", () => {
  test("keeps the hub running on loopback, builds its page once, and then has nothing to do", async () => {
    const { m, checkout } = machine();
    const first = await up(m, "--hub");
    expect(first.code).toBe(0);
    const unit = readFileSync(unitPath(m), "utf8");
    expect(unit).toContain(
      `ExecStart=/opt/bun ${checkout}/apps/cli/src/cli.ts hub --host 127.0.0.1 --port 3780 --t3-port 3773\n`
    );
    expect(unit).toContain(
      `EnvironmentFile=-${m.home}/.config/devbox/hub/env\n`
    );
    expect(unit).toContain("Restart=always");
    expect(m.units.get("user:devbox-hub.service")).toEqual({
      active: true,
      enabled: true,
    });
    expect(first.err).toContain("enabled devbox-hub.service on 127.0.0.1:3780");
    expect(first.err).toContain("built the hub page");
    expect(builds(m)).toBe(1);
    expect(m.calls).toContainEqual([
      "/opt/bun",
      "install",
      "--frozen-lockfile",
      "--filter",
      "hub",
    ]);
    expect(readFileSync(join(checkout, "apps/hub/out/.built"), "utf8")).toBe(
      "tree-1\n"
    );

    const before = m.calls.length;
    expect((await up(m, "--hub")).err).toContain("No changes.");
    expect(builds(m, before)).toBe(0);
  });

  test("listens on --host when that is one address", async () => {
    const { m } = machine();
    await up(m, "--hub", "--host", "100.64.0.21");
    expect(readFileSync(unitPath(m), "utf8")).toContain(
      "hub --host 100.64.0.21 --port 3780"
    );
  });

  test("builds the page again when hub/ has changed", async () => {
    const { m, checkout, state } = machine();
    await up(m, "--hub");
    state.tree = "tree-2";
    const before = m.calls.length;
    const second = await up(m, "--hub");
    expect(second.err).toContain("built the hub page");
    expect(builds(m, before)).toBe(1);
    expect(readFileSync(join(checkout, "apps/hub/out/.built"), "utf8")).toBe(
      "tree-2\n"
    );
    expect(m.units.get("user:devbox-hub.service")).toEqual({
      active: true,
      enabled: true,
    });
  });

  test("without --hub it stops the hub and removes its unit", async () => {
    const { m } = machine();
    await up(m, "--hub");
    const second = await up(m);
    expect(second.code).toBe(0);
    expect(second.err).toContain("removed devbox-hub.service");
    expect(existsSync(unitPath(m))).toBe(false);
    expect(m.units.get("user:devbox-hub.service")).toEqual({
      active: false,
      enabled: false,
    });
    expect((await up(m)).err).toContain("No changes.");
  });

  test("a page that does not build fails the run, and the hub still runs for its JSON", async () => {
    const { m, checkout } = machine({ buildFails: true });
    const r = await up(m, "--hub");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("the hub page did not build");
    expect(m.units.get("user:devbox-hub.service")).toEqual({
      active: true,
      enabled: true,
    });
    expect(existsSync(join(checkout, "apps/hub/out/.built"))).toBe(false);
  });

  test("without systemd it says to run the hub yourself", async () => {
    const m = makeMachine();
    const r = await up(m, "--hub");
    expect(r.code).toBe(0);
    expect(r.err).toContain("no systemd here, run `devbox hub` yourself");
  });
});
