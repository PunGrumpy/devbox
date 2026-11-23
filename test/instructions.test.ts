import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeHomes, INSTRUCTIONS_FETCH } from "../src/machine/instructions.ts";
import { installInstructions } from "../src/machine/setup.ts";
import { absolutePath } from "../src/migrate/paths.ts";
import { makeMachine } from "./support/host.ts";
import { runWith } from "./support/run.ts";

const SETTINGS = JSON.stringify({
  providerInstances: {
    claudeAgent: { driver: "claudeAgent" },
    claudeAgent_pun: { driver: "claudeAgent", config: { homePath: "~/.claude-pun" } },
    claudeAgent_work: { driver: "claudeAgent", config: { homePath: "/srv/claude-work" } },
    codex: { driver: "codex", config: { homePath: "~/.codex" } },
  },
});

describe("which Claude homes get instructions", () => {
  test("every claudeAgent instance in T3's settings, and no other driver", () => {
    expect(claudeHomes(Option.some(SETTINGS), "/home/me", "/data")).toEqual([
      "/data/.claude",
      "/home/me/.claude-pun",
      "/srv/claude-work",
    ]);
  });

  test("only $CLAUDE_CONFIG_DIR when T3 has no settings yet or they do not parse", () => {
    expect(claudeHomes(Option.none(), "/home/me", "/data")).toEqual(["/data/.claude"]);
    expect(claudeHomes(Option.some("not json"), "/home/me", "/data")).toEqual(["/data/.claude"]);
    expect(claudeHomes(Option.some("{}"), "/home/me", "/data")).toEqual(["/data/.claude"]);
  });
});

const MARKER =
  "<!-- Written by devbox from PunGrumpy/agents instructions/global.md. Edit it there; this file is overwritten. -->";

const machineServing = (source: { text: string } | undefined) => {
  const m = makeMachine();
  m.respond = (argv) =>
    argv.join(" ") === INSTRUCTIONS_FETCH.join(" ")
      ? source === undefined
        ? { code: 4, stdout: "", stderr: "gh: To get started with GitHub CLI, run gh auth login" }
        : { code: 0, stdout: source.text, stderr: "" }
      : undefined;
  const baseDir = join(m.home, ".t3");
  mkdirSync(join(baseDir, "userdata"), { recursive: true });
  writeFileSync(
    join(baseDir, "userdata", "settings.json"),
    JSON.stringify({
      providerInstances: {
        claudeAgent: { driver: "claudeAgent" },
        claudeAgent_pun: { driver: "claudeAgent", config: { homePath: "~/.claude-pun" } },
      },
    }),
  );
  const run = () =>
    runWith(
      m.host,
      installInstructions(
        { data: absolutePath(m.home), baseDir: absolutePath(baseDir) },
        m.home,
        {},
      ),
    );
  const file = (home: string) => join(m.home, home, "CLAUDE.md");
  return { run, file };
};

describe("installInstructions", () => {
  test("writes the fetched rules under a marker into each home, then changes nothing", async () => {
    const { run, file } = machineServing({ text: "# Rules\n\n- Reply in Thai.\n\n" });
    const first = await run();
    const wanted = `${MARKER}\n\n# Rules\n\n- Reply in Thai.\n`;
    expect(readFileSync(file(".claude"), "utf8")).toBe(wanted);
    expect(readFileSync(file(".claude-pun"), "utf8")).toBe(wanted);
    expect(first.err).toContain("instructions: wrote CLAUDE.md in");

    const second = await run();
    expect(second.err).toContain("instructions: up to date");
    expect(second.err).not.toContain("wrote");
  });

  test("replaces a file it wrote when the source changes", async () => {
    const source = { text: "old rule\n" };
    const { run, file } = machineServing(source);
    await run();
    source.text = "new rule\n";
    await run();
    expect(readFileSync(file(".claude"), "utf8")).toBe(`${MARKER}\n\nnew rule\n`);
  });

  test("leaves a CLAUDE.md it did not write, says so, and still writes the other home", async () => {
    const { run, file } = machineServing({ text: "rule\n" });
    mkdirSync(join(file(".claude"), ".."), { recursive: true });
    writeFileSync(file(".claude"), "# Mine\n");
    const r = await run();
    expect(readFileSync(file(".claude"), "utf8")).toBe("# Mine\n");
    expect(r.err).toContain(`instructions: left ${file(".claude")} alone, devbox did not write it`);
    expect(readFileSync(file(".claude-pun"), "utf8")).toBe(`${MARKER}\n\nrule\n`);
  });

  test("without a gh login it writes nothing and names the fix", async () => {
    const { run, file } = machineServing(undefined);
    const r = await run();
    expect(existsSync(file(".claude"))).toBe(false);
    expect(existsSync(file(".claude-pun"))).toBe(false);
    expect(r.err).toContain(
      "instructions: cannot read PunGrumpy/agents instructions/global.md; run gh auth login, then start again",
    );
  });
});
