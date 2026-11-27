import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { claudeHomes, INSTRUCTIONS_FILE } from "../src/machine/instructions.ts";
import { linkInstructions } from "../src/machine/setup.ts";
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

const machine = () => {
  const m = makeMachine();
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
  const source = join(m.base, "devbox", "instructions", "AGENTS.md");
  mkdirSync(join(source, ".."), { recursive: true });
  writeFileSync(source, "# Rules\n\n- Reply in Thai.\n");
  const run = () =>
    runWith(
      m.host,
      linkInstructions(
        { data: absolutePath(m.home), baseDir: absolutePath(baseDir) },
        m.home,
        source,
      ),
    );
  const file = (home: string) => join(m.home, home, "CLAUDE.md");
  const put = (home: string, text: string) => {
    mkdirSync(join(m.home, home), { recursive: true });
    writeFileSync(file(home), text);
  };
  return { m, run, file, put, source };
};

describe("linkInstructions", () => {
  test("links CLAUDE.md in each home to the one AGENTS.md, then changes nothing", async () => {
    const { run, file, source } = machine();
    const first = await run();
    expect(readlinkSync(file(".claude"))).toBe(source);
    expect(readlinkSync(file(".claude-pun"))).toBe(source);
    expect(readFileSync(file(".claude-pun"), "utf8")).toBe("# Rules\n\n- Reply in Thai.\n");
    expect(first.err).toContain("instructions: linked CLAUDE.md in");

    const second = await run();
    expect(second.err).toContain("instructions: up to date");
    expect(second.err).not.toContain("linked");
  });

  test("an edit to AGENTS.md shows in every home without another run", async () => {
    const { run, file, source } = machine();
    await run();
    writeFileSync(source, "new rule\n");
    expect(readFileSync(file(".claude"), "utf8")).toBe("new rule\n");
  });

  test("replaces a regular file that is an exact copy of AGENTS.md", async () => {
    const { run, file, put, source } = machine();
    put(".claude", "# Rules\n\n- Reply in Thai.\n");
    await run();
    expect(readlinkSync(file(".claude"))).toBe(source);
  });

  test("leaves a different CLAUDE.md, says so, and still links the other home", async () => {
    const { run, file, put, source } = machine();
    put(".claude", "# Mine\n");
    const r = await run();
    expect(lstatSync(file(".claude")).isSymbolicLink()).toBe(false);
    expect(readFileSync(file(".claude"), "utf8")).toBe("# Mine\n");
    expect(r.err).toContain(
      `instructions: left ${file(".claude")} alone, it is not a copy of ${source}`,
    );
    expect(readlinkSync(file(".claude-pun"))).toBe(source);
  });

  test("leaves a link that points somewhere else", async () => {
    const { m, run, file } = machine();
    const mine = join(m.base, "mine.md");
    writeFileSync(mine, "# Mine\n");
    mkdirSync(join(m.home, ".claude"), { recursive: true });
    symlinkSync(mine, file(".claude"));
    await run();
    expect(readlinkSync(file(".claude"))).toBe(mine);
  });

  test("links again a link whose target is gone, as after AGENTS.md moved", async () => {
    const { m, run, file, source } = machine();
    mkdirSync(join(m.home, ".claude"), { recursive: true });
    symlinkSync(join(m.base, "moved-away", "AGENTS.md"), file(".claude"));
    await run();
    expect(readlinkSync(file(".claude"))).toBe(source);
  });
});

test("the repo ships the AGENTS.md the links point at", () => {
  expect(INSTRUCTIONS_FILE.endsWith("/instructions/AGENTS.md")).toBe(true);
  expect(readFileSync(INSTRUCTIONS_FILE, "utf8")).toContain("Never force push.");
});
