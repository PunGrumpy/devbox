import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENTS,
  type AgentId,
  currentAgents,
  normalize,
  parseAgentsFlag,
  skillsAgentsOf,
} from "../src/machine/agents.ts";
import { serveConfig } from "../src/machine/config.ts";
import { postStart, installSkills } from "../src/machine/setup.ts";
import { parseSkillsList, skillsAddArgs, skillsStamp } from "../src/machine/skills.ts";
import { absolutePath } from "../src/migrate/paths.ts";
import { makeMachine } from "./support/host.ts";
import { devbox, runWith } from "./support/run.ts";

type Machine = ReturnType<typeof makeMachine>;

const up = (m: Machine, ...args: Array<string>) =>
  devbox({ HOME: m.home, PATH: "/usr/bin:/bin" }, ["up", "--supervisor", "detached", ...args], {
    host: m.host,
  });

const upPicking = (
  m: Machine,
  pick: ReadonlyArray<ReadonlyArray<string>>,
  ...args: Array<string>
) =>
  devbox({ HOME: m.home, PATH: "/usr/bin:/bin" }, ["up", "--supervisor", "detached", ...args], {
    host: m.host,
    pick,
  });

const MUTATING =
  /^(<detached>|<stop>|tee|npm install|bash|git config --global (--add|--unset-all))/;
const mutations = (m: Machine, from: number) =>
  m.calls
    .slice(from)
    .map((argv) => argv.filter((a) => a !== "sudo" && a !== "-n").join(" "))
    .filter((line) => MUTATING.test(line));

const savedFile = (m: Machine) => join(m.home, ".config/devbox/agents.json");
const saved = (m: Machine): unknown => JSON.parse(readFileSync(savedFile(m), "utf8"));
const binOf = (m: Machine, id: AgentId) =>
  join(m.home, ".local/bin", AGENTS.find((agent) => agent.id === id)!.bin);
const starts = (m: Machine) => m.calls.filter((c) => c[0] === "<detached>").length;
const curled = (m: Machine, url: string) => m.calls.some((c) => c[0] === "curl" && c.includes(url));

const TEMPLATE = `#!/bin/bash
skill mattpocock/skills --skill grilling
skill rauchg/skills
`;
const BOTH = ["claude-code", "codex"];

describe("with no terminal and no saved choice", () => {
  test("it installs the defaults, saves nothing, says how to choose, and a rerun changes nothing", async () => {
    const m = makeMachine();
    const first = await up(m);
    expect(first.code).toBe(0);
    expect(first.err).toContain("agents      claude, codex (default)");
    expect(first.err).toContain(
      "NOTE: no terminal to ask which agent CLIs to install, so using the defaults. Run `devbox up --agents pick` on a terminal to choose",
    );
    expect(first.err).toContain("installed Claude Code. Log in once: claude auth login");
    expect(first.err).toContain("installed Codex. Log in once: codex login --device-auth");
    expect(existsSync(binOf(m, "claude"))).toBe(true);
    expect(existsSync(binOf(m, "codex"))).toBe(true);
    expect(existsSync(binOf(m, "devin"))).toBe(false);
    expect(existsSync(savedFile(m))).toBe(false);

    const before = m.calls.length;
    const second = await up(m);
    expect(second.err).toContain("No changes. T3 Code answers on http://127.0.0.1:3773");
    expect(second.err).toContain("agents      claude, codex (default)");
    expect(mutations(m, before)).toEqual([]);
    expect(existsSync(savedFile(m))).toBe(false);
  });

  test("the NOTE names --data when it is not $HOME", async () => {
    const m = makeMachine();
    const data = join(m.base, "persist");
    const r = await up(m, "--data", data);
    expect(r.err).toContain(`Run \`devbox up --data ${data} --agents pick\``);
  });

  test("a script installer runs with HOME=<data>, detached from any terminal when setsid exists", async () => {
    const m = makeMachine({ binaries: new Set(["npm", "setsid"]) });
    const data = join(m.base, "persist");
    await up(m, "--data", data, "--agents", "claude");
    const bash = m.runs.find((run) => run.argv.includes("bash"));
    expect(bash?.argv).toEqual(["setsid", "bash"]);
    expect(bash?.env?.HOME).toBe(data);
    expect(bash?.timeoutMs).toBe(300_000);
    expect(existsSync(join(data, ".local/bin/claude"))).toBe(true);
  });
});

describe("--agents", () => {
  test("a list is saved, installs the new agent, restarts T3 once, and the flagless rerun reads it", async () => {
    const m = makeMachine();
    await up(m, "--agents", "claude");
    const before = m.calls.length;
    const startsBefore = starts(m);

    const r = await up(m, "--agents", "claude,devin");
    expect(r.code).toBe(0);
    expect(saved(m)).toEqual({ agents: ["claude", "devin"] });
    expect(r.err).toContain("agents      claude, devin (flag)");
    expect(r.err).toContain("installed Devin. Log in once: devin configure");
    expect(r.err).toContain("started T3 Code, because an agent CLI was installed");
    expect(existsSync(binOf(m, "devin"))).toBe(true);
    expect(existsSync(binOf(m, "codex"))).toBe(false);
    expect(curled(m, "https://cli.devin.ai/install.sh")).toBe(true);
    expect(starts(m)).toBe(startsBefore + 1);
    expect(m.calls.slice(before).filter((c) => c[0] === "<stop>")).toHaveLength(1);

    const again = m.calls.length;
    const rerun = await up(m);
    expect(rerun.err).toContain("agents      claude, devin (saved)");
    expect(rerun.err).toContain("No changes.");
    expect(rerun.err).not.toContain("NOTE: no terminal");
    expect(mutations(m, again)).toEqual([]);
  });

  test("the order and repeats of the list do not rewrite the file", async () => {
    const m = makeMachine();
    await up(m, "--agents", "codex,claude,codex");
    expect(readFileSync(savedFile(m), "utf8")).toBe(
      '{\n  "agents": [\n    "claude",\n    "codex"\n  ]\n}\n',
    );
    const before = m.calls.length;
    const r = await up(m, "--agents", "claude,codex");
    expect(r.err).toContain("No changes.");
    expect(mutations(m, before)).toEqual([]);
  });

  test("dropping an agent rewrites the file, uninstalls nothing, and prints how to remove it", async () => {
    const m = makeMachine();
    await up(m, "--agents", "claude,codex,devin");
    const before = m.calls.length;
    const startsBefore = starts(m);

    const r = await up(m, "--agents", "claude,devin");
    expect(r.code).toBe(0);
    expect(saved(m)).toEqual({ agents: ["claude", "devin"] });
    expect(r.err).toContain(
      `skipped Codex: no longer chosen, left installed. \`npm rm -g --prefix ${m.home}/.local @openai/codex\` removes it`,
    );
    expect(existsSync(binOf(m, "codex"))).toBe(true);
    expect(m.calls.slice(before).some((c) => c.includes("rm") || c.includes("uninstall"))).toBe(
      false,
    );
    expect(starts(m)).toBe(startsBefore);

    const dropped = await up(m, "--agents", "claude");
    expect(dropped.err).toContain(`delete ${m.home}/.local/bin/devin to remove it`);
    const rerun = await up(m);
    expect(rerun.err).not.toContain("no longer chosen");
  });

  test("none manages no agent CLI, saves an empty list, and gives skills no target", async () => {
    const m = makeMachine();
    const r = await up(m, "--agents", "none");
    expect(r.code).toBe(0);
    expect(r.err).toContain("agents      none (flag)");
    expect(saved(m)).toEqual({ agents: [] });
    expect(curled(m, "https://claude.ai/install.sh")).toBe(false);
    expect(m.calls.some((c) => c.includes("@openai/codex@latest"))).toBe(false);

    const ids = await runWith(m.host, currentAgents(m.home));
    expect([...ids.value]).toEqual([]);
    expect(skillsAgentsOf(ids.value)).toEqual([]);
    const before = m.calls.length;
    const skills = await runWith(m.host, installSkills(m.home, {}, skillsAgentsOf(ids.value)));
    expect(skills.err).toContain("skills: no chosen agent takes skills");
    expect(m.calls.length).toBe(before);
  });

  test("an unknown agent exits 2 naming it and the known ones, before any command", async () => {
    const m = makeMachine();
    const r = await up(m, "--agents", "claude,cursor");
    expect(r.code).toBe(2);
    expect(r.err).toContain(`unknown agent "cursor"; known: claude, codex, devin, opencode`);
    expect(m.calls).toEqual([]);
    expect(existsSync(savedFile(m))).toBe(false);
  });

  test("an empty item exits 2", async () => {
    const m = makeMachine();
    const r = await up(m, "--agents", "claude,,codex");
    expect(r.code).toBe(2);
    expect(r.err).toContain("empty agent name");
    expect(m.calls).toEqual([]);
  });

  test("pick without a terminal exits 2 and says to name them", async () => {
    const m = makeMachine();
    const r = await up(m, "--agents", "pick");
    expect(r.code).toBe(2);
    expect(r.err).toContain("--agents pick needs a terminal");
    expect(r.err).toContain("name them instead, for example --agents claude,codex");
    expect(m.calls).toEqual([]);
  });

  test("parseAgentsFlag reads pick, none and lists", () => {
    expect(parseAgentsFlag("pick")._tag).toBe("Success");
    expect(parseAgentsFlag(" none ")).toMatchObject({ success: { _tag: "Set", ids: [] } });
    expect(parseAgentsFlag("opencode, claude")).toMatchObject({
      success: { _tag: "Set", ids: ["claude", "opencode"] },
    });
    expect(parseAgentsFlag("claude,pick")._tag).toBe("Failure");
  });
});

describe("the picker", () => {
  test("with no saved choice it ticks the defaults, and the answer is saved", async () => {
    const m = makeMachine();
    const r = await upPicking(m, [["Claude Code", "Devin"]]);
    expect(r.code).toBe(0);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]!.choices).toEqual([
      { title: "Claude Code", selected: true },
      { title: "Codex", selected: true },
      { title: "Devin", selected: false },
      { title: "OpenCode", selected: false },
    ]);
    expect(r.err).toContain("agents      claude, devin (picked)");
    expect(saved(m)).toEqual({ agents: ["claude", "devin"] });
    expect(existsSync(binOf(m, "devin"))).toBe(true);
    expect(existsSync(binOf(m, "codex"))).toBe(false);

    const rerun = await upPicking(m, []);
    expect(rerun.asked).toEqual([]);
    expect(rerun.err).toContain("agents      claude, devin (saved)");
    expect(rerun.err).toContain("No changes.");
  });

  test("--agents pick asks again with the saved list ticked", async () => {
    const m = makeMachine();
    await up(m, "--agents", "codex,opencode");
    const r = await upPicking(m, [["Codex"]], "--agents", "pick");
    expect(r.asked[0]!.choices.filter((c) => c.selected).map((c) => c.title)).toEqual([
      "Codex",
      "OpenCode",
    ]);
    expect(saved(m)).toEqual({ agents: ["codex"] });
    expect(r.err).toContain("agents      codex (picked)");
    expect(r.err).toContain("skipped OpenCode: no longer chosen");
  });
});

describe("the saved file", () => {
  test("ids this devbox does not know are dropped with a warning", async () => {
    const m = makeMachine();
    mkdirSync(join(m.home, ".config/devbox"), { recursive: true });
    writeFileSync(savedFile(m), '{"agents":["claude","grok"]}\n');
    const r = await up(m);
    expect(r.err).toContain("ignoring grok");
    expect(r.err).toContain("agents      claude (saved)");
    expect(existsSync(binOf(m, "codex"))).toBe(false);
  });

  test("a file that does not decode counts as absent, with a warning", async () => {
    const m = makeMachine();
    mkdirSync(join(m.home, ".config/devbox"), { recursive: true });
    writeFileSync(savedFile(m), "not json");
    const r = await up(m);
    expect(r.err).toContain('is not {"agents": [...]}, ignoring it');
    expect(r.err).toContain("agents      claude, codex (default)");
  });

  test("the file lives in --data, next to nothing in $HOME", async () => {
    const m = makeMachine();
    const data = join(m.base, "persist");
    await up(m, "--data", data, "--agents", "codex");
    expect(existsSync(join(data, ".config/devbox/agents.json"))).toBe(true);
    expect(existsSync(savedFile(m))).toBe(false);
    const rerun = await up(m, "--data", data);
    expect(rerun.err).toContain("agents      codex (saved)");
  });
});

describe("a failed install", () => {
  test("exits 0, still starts T3, and the next run tries again", async () => {
    const m = makeMachine();
    m.brokenInstallers.add("claude");
    const r = await up(m, "--agents", "claude,codex");
    expect(r.code).toBe(0);
    expect(r.err).toContain("✖ Claude Code did not install. The next devbox up tries again");
    expect(r.err).toContain("claude: install failed");
    expect(r.err).not.toContain("installed Claude Code");
    expect(r.err).toContain("installed Codex");
    expect(r.err).toContain("T3 Code answers on");
    expect(m.processes).toHaveLength(1);

    m.brokenInstallers.clear();
    const retry = await up(m);
    expect(retry.err).toContain("installed Claude Code");
    expect(existsSync(binOf(m, "claude"))).toBe(true);
  });

  test("an agent already on PATH is present, so nothing installs", async () => {
    const m = makeMachine({ binaries: new Set(["npm", "claude", "codex"]) });
    const r = await up(m);
    expect(r.code).toBe(0);
    expect(curled(m, "https://claude.ai/install.sh")).toBe(false);
    expect(m.calls.some((c) => c.includes("@openai/codex@latest"))).toBe(false);
  });
});

describe("skills follow the choice", () => {
  const list = parseSkillsList(TEMPLATE);

  test("the --agent names come from the chosen agents that take skills", () => {
    expect(skillsAgentsOf(normalize(["opencode", "claude", "devin"]))).toEqual([
      "claude-code",
      "devin",
      "opencode",
    ]);
    expect(skillsAddArgs(list.sources[0]!, ["claude-code", "devin"]).slice(-3)).toEqual([
      "--agent",
      "claude-code",
      "devin",
    ]);
  });

  test("the stamp names the list and the agents it was installed for", () => {
    expect(skillsStamp(list, BOTH)).toBe(`${list.hash} claude-code,codex`);
    expect(skillsStamp(list, ["claude-code"])).toBe(`${list.hash} claude-code`);
    expect(skillsStamp(list, [...BOTH, "devin"])).toBe(`${list.hash} claude-code,codex,devin`);
  });

  test("choosing a new agent installs the skills again for it, and only then", async () => {
    const m = makeMachine();
    m.respond = (argv) =>
      argv[0] === "curl" || argv[0] === "npx"
        ? { code: 0, stdout: TEMPLATE, stderr: "" }
        : undefined;
    const npx = () => m.calls.filter((c) => c[0] === "npx");

    await runWith(m.host, installSkills(m.home, {}, BOTH));
    expect(readFileSync(join(m.home, ".devbox-skills"), "utf8").trim()).toBe(
      `${list.hash} claude-code,codex`,
    );
    expect(npx()).toHaveLength(2);

    await runWith(m.host, installSkills(m.home, {}, BOTH));
    expect(npx()).toHaveLength(2);

    await runWith(m.host, installSkills(m.home, {}, [...BOTH, "devin"]));
    expect(npx()).toHaveLength(4);
    expect(npx().at(-1)?.slice(-4)).toEqual(["--agent", "claude-code", "codex", "devin"]);
    expect(readFileSync(join(m.home, ".devbox-skills"), "utf8").trim()).toBe(
      `${list.hash} claude-code,codex,devin`,
    );
  });
});

describe("devbox serve keeps the chosen agents current", () => {
  const serving = (m: Machine) =>
    serveConfig(
      {
        data: Option.some(m.home),
        port: 3773,
        baseDir: Option.none(),
        workspace: Option.none(),
        publicUrl: Option.none(),
        setup: true,
      },
      absolutePath(m.home),
    );

  test("npm agents reinstall @latest, Claude and Devin are left alone, and skills get the targets", async () => {
    const m = makeMachine();
    mkdirSync(join(m.home, ".config/devbox"), { recursive: true });
    writeFileSync(savedFile(m), '{"agents":["claude","codex","devin","opencode"]}\n');
    mkdirSync(join(m.home, ".local/bin"), { recursive: true });
    for (const bin of ["claude", "codex", "devin"])
      writeFileSync(join(m.home, ".local/bin", bin), "");
    m.respond = (argv) =>
      argv[0] === "curl" && argv.some((a) => a.includes("dotfiles"))
        ? { code: 0, stdout: TEMPLATE, stderr: "" }
        : argv[0] === "npx"
          ? { code: 0, stdout: "", stderr: "" }
          : undefined;
    const { err } = await runWith(m.host, postStart(serving(m)));
    const prefix = join(m.home, ".local");
    expect(m.calls).toContainEqual([
      "npm",
      "install",
      "-g",
      "--prefix",
      prefix,
      "@openai/codex@latest",
    ]);
    expect(m.calls.some((c) => c[0] === "devin")).toBe(false);
    expect(m.calls.some((c) => c.includes("opencode-ai@latest"))).toBe(false);
    expect(m.calls.some((c) => c[0] === "claude")).toBe(false);
    expect(err).toContain("agents: Codex is current");
    expect(err).toContain("agents: OpenCode is chosen but not installed, run `devbox up`");
    expect(m.calls.find((c) => c[0] === "npx")?.slice(-5)).toEqual([
      "--agent",
      "claude-code",
      "codex",
      "devin",
      "opencode",
    ]);
  });

  test("with no saved file it updates the defaults, and never asks", async () => {
    const m = makeMachine();
    const ids = await runWith(m.host, currentAgents(m.home));
    expect([...ids.value]).toEqual(["claude", "codex"]);
  });

  test("gh joins the mise line only when it is not on PATH", async () => {
    const withGh = makeMachine({ binaries: new Set(["npm", "gh"]) });
    const without = makeMachine();
    for (const m of [withGh, without]) {
      mkdirSync(join(m.home, ".local/bin"), { recursive: true });
      writeFileSync(join(m.home, ".local/bin/mise"), "");
      await runWith(m.host, postStart(serving(m)));
    }
    const miseUse = (m: Machine) => m.calls.find((c) => c.includes("--global"))!;
    expect(miseUse(without)).toContain("gh@latest");
    expect(miseUse(withGh)).not.toContain("gh@latest");
  });
});

describe("the README", () => {
  const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");

  test.each(AGENTS.map((agent) => [agent.id, agent.login]))(
    "lists the agent %s and how to log in with `%s`",
    (id, login) => {
      expect(readme).toContain(`\`${id}\``);
      expect(readme).toContain(`\`${login}\``);
    },
  );
});
