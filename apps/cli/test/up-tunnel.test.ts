import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Ran } from "../src/machine/host.ts";
import { makeMachine } from "./support/host.ts";
import type { FakeMachine } from "./support/host.ts";
import { devbox } from "./support/run.ts";

const TOKEN = Buffer.from(
  JSON.stringify({ a: "made-up", t: "made-up", s: "made-up" })
).toString("base64");

const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });

const machine = (
  options: { token?: boolean; overrides?: Partial<FakeMachine> } = {}
) => {
  const m = makeMachine(options.overrides ?? { userBus: true });

  const installed = join(
    m.base,
    "mise",
    "installs",
    "cloudflared",
    "bin",
    "cloudflared"
  );

  mkdirSync(join(m.home, ".local", "bin"), { recursive: true });
  writeFileSync(join(m.home, ".local", "bin", "mise"), "");
  m.respond = (argv) => {
    if (argv[0]?.endsWith("/mise") && argv[1] === "use") {
      mkdirSync(dirname(installed), { recursive: true });
      writeFileSync(installed, "");

      return ok();
    }

    if (argv[0]?.endsWith("/mise") && argv[1] === "which") {
      return ok(`${installed}\n`);
    }

    return undefined;
  };

  if (options.token !== false) {
    mkdirSync(join(m.home, ".config", "cloudflared"), { recursive: true });
    writeFileSync(tokenPath(m), TOKEN, { mode: 0o600 });
  }

  return { m, installed };
};

const tokenPath = (m: ReturnType<typeof makeMachine>) =>
  join(m.home, ".config", "cloudflared", "token");

const unitPath = (m: ReturnType<typeof makeMachine>) =>
  join(m.home, ".config/systemd/user/cloudflared-t3.service");

const machineJson = (m: ReturnType<typeof makeMachine>) =>
  readFileSync(join(m.home, ".config/devbox/machine.json"), "utf-8");

const up = (m: ReturnType<typeof makeMachine>, ...args: string[]) =>
  devbox({ HOME: m.home, PATH: "/usr/bin:/bin" }, ["up", ...args], {
    host: m.host,
  });

const readmeUnit = () => {
  const readme = readFileSync(
    join(import.meta.dir, "..", "..", "..", "README.md"),
    "utf-8"
  );

  const section = readme.slice(
    readme.indexOf("### Reach T3 without Tailscale")
  );

  const block =
    /```ini\n(?<body>[\s\S]*?)```/.exec(section)?.groups?.body ?? "";

  return block
    .split("\n")
    .map((line) => line.replace(/^ {3}/, ""))
    .join("\n");
};

describe("devbox up --tunnel", () => {
  test("installs cloudflared, keeps the README's unit running, and then has nothing to do", async () => {
    const { m, installed } = machine();
    const first = await up(m, "--tunnel");
    expect(first.code).toBe(0);
    expect(readlinkSync(join(m.home, ".local/bin/cloudflared"))).toBe(
      installed
    );
    expect(m.calls).toContainEqual([
      join(m.home, ".local/bin/mise"),
      "use",
      "--global",
      "--yes",
      "cloudflared",
    ]);
    expect(readFileSync(unitPath(m), "utf-8")).toBe(readmeUnit());
    expect(m.units.get("user:cloudflared-t3.service")).toEqual({
      active: true,
      enabled: true,
    });
    expect(first.err).toContain("installed cloudflared at");
    expect(first.err).toContain("enabled cloudflared-t3.service");
    expect(JSON.parse(machineJson(m)).up).toContain("--tunnel");

    const before = m.calls.length;
    const second = await up(m, "--tunnel");
    expect(second.err).toContain("No changes.");
    expect(
      m.calls.slice(before).some((argv) => argv[0]?.endsWith("/mise"))
    ).toBe(false);
  });

  test("the recorded flags keep the tunnel on a plain run of them", async () => {
    const { m } = machine();
    await up(m, "--tunnel", "--name", "edge-7");
    const again = await up(m, ...JSON.parse(machineJson(m)).up);
    expect(again.code).toBe(0);
    expect(again.err).toContain("No changes.");
  });

  test("without --tunnel it stops cloudflared and removes its unit, and leaves the token alone", async () => {
    const { m } = machine();
    await up(m, "--tunnel");
    const second = await up(m);
    expect(second.code).toBe(0);
    expect(second.err).toContain(
      "removed cloudflared-t3.service, because --tunnel is off"
    );
    expect(existsSync(unitPath(m))).toBe(false);
    expect(m.units.get("user:cloudflared-t3.service")).toEqual({
      active: false,
      enabled: false,
    });
    expect(readFileSync(tokenPath(m), "utf-8")).toBe(TOKEN);
    expect((await up(m)).err).toContain("No changes.");
  });

  test("a link to cloudflared that leads nowhere, as after a rebuild, is made again", async () => {
    const { m, installed } = machine();
    await up(m, "--tunnel");
    const link = join(m.home, ".local/bin/cloudflared");
    rmSync(link);
    symlinkSync(join(m.base, "gone"), link);
    const second = await up(m, "--tunnel");
    expect(second.err).toContain("installed cloudflared at");
    expect(readlinkSync(link)).toBe(installed);
  });

  test("without a token it fails before it changes anything, and says where the token goes", async () => {
    const { m } = machine({ token: false });
    const r = await up(m, "--tunnel");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(
      `--tunnel needs the tunnel's token in ${tokenPath(m)}`
    );
    expect(r.err).toContain("the hub saves it when it publishes this machine");
    expect(existsSync(unitPath(m))).toBe(false);
    expect(existsSync(join(m.home, ".config/devbox/machine.json"))).toBe(false);
  });

  test("never reads the token: one it cannot read still runs, and the token is nowhere it wrote", async () => {
    const { m } = machine();
    chmodSync(tokenPath(m), 0o000);
    const r = await up(m, "--tunnel");
    expect(r.code).toBe(0);
    chmodSync(tokenPath(m), 0o600);
    expect(lstatSync(tokenPath(m)).isFile()).toBe(true);
    expect(`${r.out}${r.err}`).not.toContain(TOKEN);
    expect(machineJson(m)).not.toContain(TOKEN);
    expect(readFileSync(unitPath(m), "utf-8")).not.toContain(TOKEN);
    expect(JSON.stringify(m.calls)).not.toContain(TOKEN);
  });

  test("a system unit runs as the user and names the user's home, since %h there is root's", async () => {
    const { m } = machine({ overrides: { sudo: true, systemd: true } });
    const r = await up(m, "--tunnel");
    expect(r.code).toBe(0);

    const unit = readFileSync(
      join(m.etc, "systemd/system/cloudflared-t3.service"),
      "utf-8"
    );

    expect(unit).toContain("User=agent\n");
    expect(unit).toContain(
      `ExecStart=${m.home}/.local/bin/cloudflared tunnel --no-autoupdate run --token-file ${m.home}/.config/cloudflared/token\n`
    );
    expect(unit).toContain("WantedBy=multi-user.target\n");
    expect(m.units.get("system:cloudflared-t3.service")).toEqual({
      active: true,
      enabled: true,
    });
  });

  test("without systemd it says to run cloudflared yourself", async () => {
    const { m } = machine();
    const r = await up(m, "--tunnel", "--supervisor", "detached");
    expect(r.code).toBe(0);
    expect(r.err).toContain("no systemd here, run `cloudflared tunnel run");
  });
});
