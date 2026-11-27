import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  gitEntries,
  processEnv,
  profileScript,
  settingsFor,
} from "../src/machine/settings.ts";
import { browserLibraries, installSkills } from "../src/machine/setup.ts";
import { parseSkillsList, skillsAddArgs } from "../src/machine/skills.ts";
import { makeMachine } from "./support/host.ts";
import { runWith } from "./support/run.ts";

describe("one settings list, three sinks", () => {
  const settings = settingsFor("/data");

  test("git gets identity, no signing, and the gh credential helper", () => {
    expect(
      gitEntries(settings).map(({ key, values }) => [key, values])
    ).toEqual([
      ["user.name", ["PunGrumpy"]],
      ["user.email", ["108584943+PunGrumpy@users.noreply.github.com"]],
      ["commit.gpgsign", ["false"]],
      ["credential.https://github.com.helper", ["", "!gh auth git-credential"]],
    ]);
  });

  test("the process env keeps tool data in --data and prepends its bins to PATH", () => {
    expect(processEnv(settings, "/usr/bin")).toEqual({
      MISE_DATA_DIR: "/data/.local/share/mise",
      RUSTUP_HOME: "/data/.rustup",
      CARGO_HOME: "/data/.cargo",
      CLAUDE_CONFIG_DIR: "/data/.claude",
      PATH: "/data/.local/bin:/data/.local/share/mise/shims:/usr/bin",
    });
  });

  test("the login profile exports the same values, quoted, without git plumbing", () => {
    expect(profileScript(settingsFor("/it's"), "agent")).toBe(
      [
        `if [ "$(id -un)" = 'agent' ]; then`,
        `  export MISE_DATA_DIR='/it'\\''s/.local/share/mise'`,
        `  export RUSTUP_HOME='/it'\\''s/.rustup'`,
        `  export CARGO_HOME='/it'\\''s/.cargo'`,
        `  export CLAUDE_CONFIG_DIR='/it'\\''s/.claude'`,
        `  export PATH='/it'\\''s/.local/bin':'/it'\\''s/.local/share/mise/shims':"$PATH"`,
        "fi",
        "",
      ].join("\n")
    );
    const me = Bun.spawnSync(["id", "-un"]).stdout.toString().trim();

    const sourced = (user: string) =>
      Bun.spawnSync([
        "sh",
        "-c",
        `${profileScript(settingsFor("/it's"), user)}printf %s "$CLAUDE_CONFIG_DIR"`,
      ]).stdout.toString();

    expect(sourced(me)).toBe("/it's/.claude");
    expect(sourced("someone-else")).toBe("");
  });
});

const BOTH = ["claude-code", "codex"];

const TEMPLATE = `#!/bin/bash
skill() { bunx skills add "$@" --global --yes </dev/null; }
skill mattpocock/skills --skill grilling
skill rauchg/skills
skill git@github.com:PunGrumpy/agents.git --skill cli-builder dx-design
`;

describe("the skills list is data", () => {
  test("lines become {repo, skills} records, private repos over HTTPS", () => {
    const list = parseSkillsList(TEMPLATE);
    expect(list.sources).toEqual([
      { repo: "mattpocock/skills", skills: ["grilling"] },
      { repo: "rauchg/skills", skills: [] },
      {
        repo: "https://github.com/PunGrumpy/agents.git",
        skills: ["cli-builder", "dx-design"],
      },
    ]);
    expect(list.rejected).toEqual([]);
    expect(skillsAddArgs(list.sources[2]!, ["claude-code", "codex"])).toEqual([
      "npx",
      "-y",
      "skills",
      "add",
      "https://github.com/PunGrumpy/agents.git",
      "--skill",
      "cli-builder",
      "dx-design",
      "--global",
      "--yes",
      "--copy",
      "--agent",
      "claude-code",
      "codex",
    ]);
  });

  test("the stamp hash matches the one the shell script wrote, so live boxes do not reinstall", () => {
    const lines = TEMPLATE.split("\n")
      .filter((l) => l.startsWith("skill "))
      .map((l) => l.replace("git@github.com:", "https://github.com/"));

    expect(parseSkillsList(TEMPLATE).hash).toBe(
      createHash("sha256").update(lines.join("\n")).digest("hex")
    );
  });

  test.each([
    "skill foo/bar; touch /tmp/pwned",
    "skill $(touch /tmp/pwned)",
    "skill foo/bar --skill `touch /tmp/pwned`",
    "skill foo/bar --exec touch",
    "skill ../etc --skill x",
    "skill https://github.com/../x",
  ])("rejects %p", (line) => {
    const list = parseSkillsList(`${TEMPLATE}${line}\n`);
    expect(list.rejected).toEqual([line]);
    expect(list.sources).toHaveLength(3);
  });

  test("a malicious line never runs, and the stamp waits for a clean list", async () => {
    const m = makeMachine();
    const marker = join(m.base, "pwned");
    const remote = `${TEMPLATE}skill foo/bar; touch ${marker}\nskill $(touch ${marker})\n`;
    m.respond = (argv) =>
      argv[0] === "curl"
        ? { code: 0, stdout: remote, stderr: "" }
        : argv[0] === "npx"
          ? { code: 0, stdout: "", stderr: "" }
          : undefined;
    const { err } = await runWith(m.host, installSkills(m.home, {}, BOTH));
    expect(existsSync(marker)).toBe(false);
    expect(m.calls.filter((c) => c[0] === "npx").map((c) => c[4])).toEqual([
      "mattpocock/skills",
      "rauchg/skills",
      "https://github.com/PunGrumpy/agents.git",
    ]);
    expect(m.calls.flat().some((arg) => arg.includes(marker))).toBe(false);
    expect(err).toContain(
      `ignored a line that is not a skill source: skill foo/bar; touch ${marker}`
    );
    expect(err).toContain("2 sources failed, trying again on the next start");
    expect(existsSync(join(m.home, ".devbox-skills"))).toBe(false);
  });

  test("a clean list writes the stamp, and the next start skips the install", async () => {
    const m = makeMachine();
    m.respond = (argv) =>
      argv[0] === "curl" || argv[0] === "npx"
        ? { code: 0, stdout: TEMPLATE, stderr: "" }
        : undefined;
    await runWith(m.host, installSkills(m.home, {}, BOTH));
    expect(readFileSync(join(m.home, ".devbox-skills"), "utf-8").trim()).toBe(
      `${parseSkillsList(TEMPLATE).hash} ${BOTH.join(",")}`
    );
    const before = m.calls.length;
    const { err } = await runWith(m.host, installSkills(m.home, {}, BOTH));
    expect(err).toContain("skills: up to date");
    expect(m.calls.slice(before).filter((c) => c[0] === "npx")).toEqual([]);
    writeFileSync(join(m.home, ".devbox-skills"), "stale\n");
  });
});

describe("browser libraries", () => {
  test("on Ubuntu 24.04 it installs the t64 package that replaced libasound2", async () => {
    const m = makeMachine({ binaries: new Set(["apt-get"]) });
    m.respond = (argv) => {
      if (argv[0] === "apt-cache") {
        return {
          code: 0,
          stdout:
            argv[2] === "libasound2t64"
              ? "Candidate: 1.2.11\n"
              : "Candidate: (none)\n",
          stderr: "",
        };
      }

      if (argv[0] === "dpkg") {
        return { code: 1, stdout: "", stderr: "" };
      }

      if (argv[0] === "sudo") {
        return { code: 0, stdout: "", stderr: "" };
      }

      return undefined;
    };

    await runWith(m.host, browserLibraries);
    const install = m.calls.find((c) => c.includes("install"));
    expect(install).toContain("libasound2t64");
    expect(install).not.toContain("libasound2");
    expect(install).toContain("libnss3");
  });
});
