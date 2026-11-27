import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { SHELL_DIR, setupShell } from "../src/machine/shell.ts";
import { makeMachine } from "./support/host.ts";
import type { FakeMachine } from "./support/host.ts";
import { runWith } from "./support/run.ts";

const passwd = (shell: string) => (argv: readonly string[]) => {
  if (argv[0] === "getent") {
    return { code: 0, stdout: `me:x:1:1::/home/me:${shell}\n`, stderr: "" };
  }

  if (argv[0] === "sudo" && argv[2] === "chsh") {
    return { code: 0, stdout: "", stderr: "" };
  }
};

const setup = async (m: FakeMachine) =>
  await runWith(m.host, setupShell(m.home));

describe("setupShell", () => {
  test("links the zsh and Starship files, then changes nothing", async () => {
    const m = makeMachine({ binaries: new Set(["zsh"]) });
    m.respond = passwd("/usr/bin/zsh");
    await setup(m);
    expect(readlinkSync(path.join(m.home, ".zprofile"))).toBe(
      path.join(SHELL_DIR, "zprofile")
    );
    expect(readlinkSync(path.join(m.home, ".zshrc"))).toBe(
      path.join(SHELL_DIR, "zshrc")
    );
    expect(readlinkSync(path.join(m.home, ".config/starship.toml"))).toBe(
      path.join(SHELL_DIR, "starship.toml")
    );
    const second = await setup(m);
    expect(second.err).not.toContain("linked");
    expect(m.calls.some((c) => c.includes("chsh"))).toBe(false);
  });

  test("leaves a .zshrc of your own alone", async () => {
    const m = makeMachine({ binaries: new Set(["zsh"]) });
    mkdirSync(m.home, { recursive: true });
    writeFileSync(path.join(m.home, ".zshrc"), "mine\n");
    const { err } = await setup(m);
    expect(readFileSync(path.join(m.home, ".zshrc"), "utf-8")).toBe("mine\n");
    expect(err).toContain("it is not ours");
  });

  test("links again a .zshrc whose target is gone, as after its source moved", async () => {
    const m = makeMachine({ binaries: new Set(["zsh"]) });
    mkdirSync(m.home, { recursive: true });
    symlinkSync(
      path.join(m.base, "moved-away", "zshrc"),
      path.join(m.home, ".zshrc")
    );
    const { err } = await setup(m);
    expect(readlinkSync(path.join(m.home, ".zshrc"))).toBe(
      path.join(SHELL_DIR, "zshrc")
    );
    expect(err).not.toContain("it is not ours");
  });

  test("makes zsh the login shell when it is another one", async () => {
    const m = makeMachine({ binaries: new Set(["zsh"]), sudo: true });
    m.respond = passwd("/bin/bash");
    const { err } = await setup(m);
    expect(m.calls).toContainEqual([
      "sudo",
      "-n",
      "chsh",
      "-s",
      "/usr/bin/zsh",
      m.host.user,
    ]);
    expect(err).toContain("login shell is now zsh");
  });

  test("without sudo it prints what an admin runs and changes no login shell", async () => {
    const m = makeMachine();
    const { err } = await setup(m);
    expect(err).toContain("sudo apt-get install -y zsh");
    expect(m.calls.some((c) => c.includes("chsh"))).toBe(false);
    expect(existsSync(path.join(m.home, ".zshrc"))).toBe(true);
  });
});
