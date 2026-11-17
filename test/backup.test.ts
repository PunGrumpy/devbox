import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SOURCES, parseEnv } from "../src/backup/config.ts";
import {
  excludeFile,
  hasSqliteHeader,
  parseSources,
  sqliteBackupArgs,
} from "../src/backup/model.ts";
import { absolutePath } from "../src/migrate/paths.ts";
import { envFile, makeSqlite, sourcesFile, withBackupTools, write } from "./support/backup.ts";
import { makeMachine } from "./support/host.ts";
import { devbox } from "./support/run.ts";

const backup = (m: ReturnType<typeof makeMachine>, ...args: Array<string>) =>
  devbox({ HOME: m.home, PATH: "/usr/bin:/bin" }, ["backup", ...args], { host: m.host });

const ENV = `RESTIC_REPOSITORY=s3:https://acct.r2.cloudflarestorage.com/bucket/box
RESTIC_PASSWORD=hunter2-password
AWS_ACCESS_KEY_ID=AKIAEXAMPLEKEY
AWS_SECRET_ACCESS_KEY=topsecretvalue
AWS_DEFAULT_REGION=auto
`;

const stateDir = (m: ReturnType<typeof makeMachine>) => join(m.home, ".local/state/devbox/backup");

const fixture = () => {
  const m = makeMachine();
  const repo = withBackupTools(m);
  envFile(m.home, ENV);
  write(join(m.home, ".config/devbox/backup/excludes"), "node_modules\n");
  makeSqlite(join(m.home, ".codex/state.sqlite"), 3, true);
  makeSqlite(join(m.home, ".codex/logs_1.sqlite"), 1);
  write(join(m.home, ".codex/notes.sqlite"), "this is not a database, only named like one\n");
  write(join(m.home, ".codex/rollout/session.jsonl"), '{"a":1}\n');
  makeSqlite(join(m.home, ".gemini/tmp/abc/chat.db"), 2);
  write(join(m.home, ".gemini/cache.db"), "plain text in a .db file\n");
  write(join(m.home, ".gemini/empty.db"), "");
  write(join(m.home, ".claude.json"), '{"projects":{}}\n');
  symlinkSync(join(m.home, ".codex/state.sqlite"), join(m.home, ".gemini/link.db"));
  sourcesFile(
    m.home,
    `# agents
codex   ~/.codex
gemini  ~/.gemini
claude-json ~/.claude.json
grok    ~/.grok
`,
  );
  return { m, repo };
};

const resticCalls = (m: ReturnType<typeof makeMachine>) =>
  m.calls.filter((argv) => argv[0] === "restic");

describe("the sources file", () => {
  test("is read as `<name> <path>` lines, with ~ expanded and comments ignored", () => {
    const home = absolutePath("/home/agent");
    const parsed = parseSources(
      "# agents\n\ncodex ~/.codex\nroot  /srv/data\nhome ~\nspaced   /srv/with space/dir  \n",
      home,
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.sources.map(({ name, path }) => ({ name, path: String(path) }))).toEqual([
      { name: "codex", path: "/home/agent/.codex" },
      { name: "root", path: "/srv/data" },
      { name: "home", path: "/home/agent" },
      { name: "spaced", path: "/srv/with space/dir" },
    ]);
  });

  test.each([
    ["only-a-name"],
    ["name relative/path"],
    ["name ~other/path"],
    ["bad/name /srv/x"],
    ["-lead /srv/x"],
  ])("rejects %p", (line) => {
    const parsed = parseSources(`ok /srv/ok\n${line}\n`, absolutePath("/home/agent"));
    expect(parsed.sources.map((s) => s.name)).toEqual(["ok"]);
    expect(parsed.issues.map((i) => i.line)).toEqual([2]);
  });

  test("rejects a name used twice, because both would stage into one folder", () => {
    const parsed = parseSources("a /srv/one\na /srv/two\n", absolutePath("/home/agent"));
    expect(parsed.issues).toEqual([{ line: 2, why: "the name a is already used" }]);
  });

  test("`backup sources` lists existing paths on stdout and notes the missing ones", async () => {
    const { m } = fixture();
    const r = await backup(m, "sources");
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `codex\t${m.home}/.codex\ngemini\t${m.home}/.gemini\nclaude-json\t${m.home}/.claude.json\n`,
    );
    expect(r.err).toContain(`skip grok: ${m.home}/.grok not found`);
  });

  test("a line that is not `<name> <path>` stops the command and names the line", async () => {
    const m = makeMachine();
    withBackupTools(m);
    sourcesFile(m.home, "codex ~/.codex\nthis line is wrong\n");
    const sources = await backup(m, "sources");
    expect(sources.code).toBe(1);
    expect(sources.err).toContain("has 1 line that cannot be read");
    expect(sources.err).toContain("line 2:");
    envFile(m.home, ENV);
    const run = await backup(m, "run");
    expect(run.code).toBe(1);
    expect(resticCalls(m)).toEqual([]);
  });

  test("a source behind a symlink is backed up through its real path", async () => {
    const { m } = fixture();
    write(join(m.base, "persist/.agents/skills.md"), "x\n");
    symlinkSync(join(m.base, "persist/.agents"), join(m.home, ".agents"));
    sourcesFile(m.home, "agents ~/.agents\n");
    await backup(m, "run");
    const argv = resticCalls(m).find((c) => c[1] === "backup")!;
    expect(argv).toContain(join(m.base, "persist/.agents"));
    expect(argv).not.toContain(join(m.home, ".agents"));
  });
});

describe("config files", () => {
  test("defaults are written when missing, the env file is private, and nothing is overwritten", async () => {
    const m = makeMachine();
    withBackupTools(m);
    const first = await backup(m, "sources");
    expect(first.code).toBe(0);
    const dir = join(m.home, ".config/devbox/backup");
    expect(readFileSync(join(dir, "sources"), "utf8")).toBe(DEFAULT_SOURCES);
    expect(readFileSync(join(dir, "excludes"), "utf8")).toContain("$HOME/.codex/logs_*.sqlite*");
    expect(statSync(join(dir, "env")).mode & 0o777).toBe(0o600);
    expect(first.err).toContain(`created ${dir}/env`);
    const env = readFileSync(join(dir, "env"), "utf8");
    expect(env).toContain("RESTIC_REPOSITORY=\n");
    expect(env).toContain(`RESTIC_PASSWORD_FILE=${dir}/restic-password\n`);

    write(join(dir, "sources"), "mine ~/mine\n");
    write(join(dir, "env"), "RESTIC_REPOSITORY=kept\n");
    chmodSync(join(dir, "env"), 0o640);
    const second = await backup(m, "sources");
    expect(second.err).not.toContain("created");
    expect(readFileSync(join(dir, "sources"), "utf8")).toBe("mine ~/mine\n");
    expect(readFileSync(join(dir, "env"), "utf8")).toBe("RESTIC_REPOSITORY=kept\n");
    expect(statSync(join(dir, "env")).mode & 0o777).toBe(0o640);
  });

  test("the env file reads NAME=value lines and reports bad ones by number only", () => {
    expect(
      parseEnv("# c\nA=1\nB = two words \nC='quoted value'\nD=\"x=y\"\nnot a pair\n9X=1\n"),
    ).toEqual({
      values: { A: "1", B: "two words", C: "quoted value", D: "x=y" },
      invalid: [6, 7],
    });
  });

  test("a run with no repository set asks for the env file and runs nothing", async () => {
    const m = makeMachine();
    withBackupTools(m);
    const r = await backup(m, "run");
    expect(r.code).toBe(1);
    expect(r.err).toContain("RESTIC_REPOSITORY is not set in");
    expect(resticCalls(m)).toEqual([]);
  });

  test("a missing restic or sqlite3 is a clear error before any work", async () => {
    const { m } = fixture();
    m.binaries.delete("restic");
    m.binaries.delete("sqlite3");
    const r = await backup(m, "run");
    expect(r.code).toBe(1);
    expect(r.err).toContain("restic and sqlite3 are not installed");
    expect(r.err).toContain("devbox up");
    expect(m.calls).toEqual([]);
  });
});

describe("devbox backup run", () => {
  test("finds SQLite files by their header and snapshots only those", async () => {
    const { m } = fixture();
    const r = await backup(m, "run");
    expect(r.code).toBe(0);

    const snapshotted = m.calls
      .filter((c) => c[0] === "sqlite3" && c.at(-1)?.startsWith(".backup"))
      .map((c) => c.at(-2));
    expect(snapshotted.toSorted()).toEqual(
      [
        `${m.home}/.codex/logs_1.sqlite`,
        `${m.home}/.codex/state.sqlite`,
        `${m.home}/.gemini/tmp/abc/chat.db`,
      ].toSorted(),
    );

    const stage = join(stateDir(m), "sqlite");
    for (const staged of ["codex/state.sqlite", "codex/logs_1.sqlite", "gemini/tmp/abc/chat.db"])
      expect(existsSync(join(stage, staged))).toBe(true);
    for (const absent of [
      "codex/notes.sqlite",
      "gemini/cache.db",
      "gemini/empty.db",
      "gemini/link.db",
      "codex/rollout/session.jsonl",
      "claude-json/.claude.json",
    ])
      expect(existsSync(join(stage, absent))).toBe(false);
    expect(existsSync(`${stage}.tmp`)).toBe(false);
    expect(r.err).toContain(`skip grok: ${m.home}/.grok not found`);
    expect(r.err).toContain("sqlite snapshots: 3");
  });

  test("excludes each live database and its -wal, -shm and -journal from restic", async () => {
    const { m } = fixture();
    await backup(m, "run");
    const lines = readFileSync(join(stateDir(m), "sqlite-excludes"), "utf8").split("\n");
    const live = [
      `${m.home}/.codex/state.sqlite`,
      `${m.home}/.codex/logs_1.sqlite`,
      `${m.home}/.gemini/tmp/abc/chat.db`,
    ];
    expect(lines.filter((l) => l !== "").toSorted()).toEqual(
      live.flatMap((p) => [p, `${p}-wal`, `${p}-shm`, `${p}-journal`]).toSorted(),
    );
    expect(lines).not.toContain(`${m.home}/.codex/notes.sqlite`);
  });

  test("calls restic with the documented argv, and initializes only a missing repository", async () => {
    const { m, repo } = fixture();
    const first = await backup(m, "run");
    expect(first.code).toBe(0);
    const stage = join(stateDir(m), "sqlite");
    expect(resticCalls(m)).toEqual([
      ["restic", "cat", "config"],
      ["restic", "init"],
      [
        "restic",
        "backup",
        "--tag",
        "agent-backup",
        "--exclude-caches",
        "--exclude-file",
        join(stateDir(m), "sqlite-excludes"),
        "--exclude-file",
        join(m.home, ".config/devbox/backup/excludes"),
        `${m.home}/.codex`,
        `${m.home}/.gemini`,
        `${m.home}/.claude.json`,
        stage,
      ],
      [
        "restic",
        "forget",
        "--tag",
        "agent-backup",
        "--group-by",
        "host,tags",
        "--keep-daily",
        "7",
        "--keep-weekly",
        "4",
        "--keep-monthly",
        "6",
        "--prune",
      ],
    ]);
    expect(repo.exists).toBe(true);

    m.calls.length = 0;
    const second = await backup(m, "run");
    expect(second.code).toBe(0);
    expect(resticCalls(m).map((c) => c[1])).toEqual(["cat", "backup", "forget"]);
  });

  test("restic gets the env file, and no secret is printed", async () => {
    const { m } = fixture();
    const r = await backup(m, "run");
    const backupRun = m.runs.find((c) => c.argv[1] === "backup")!;
    expect(backupRun.env).toMatchObject({
      RESTIC_REPOSITORY: "s3:https://acct.r2.cloudflarestorage.com/bucket/box",
      RESTIC_PASSWORD: "hunter2-password",
      AWS_SECRET_ACCESS_KEY: "topsecretvalue",
    });
    for (const secret of ["hunter2-password", "topsecretvalue", "AKIAEXAMPLEKEY"]) {
      expect(r.out).not.toContain(secret);
      expect(r.err).not.toContain(secret);
    }
  });

  test("a repository restic cannot open is an error, not a new repository", async () => {
    const { m } = fixture();
    const original = m.respond;
    m.respond = (argv) =>
      argv[1] === "cat"
        ? { code: 12, stdout: "", stderr: "Fatal: wrong password or no key found\n" }
        : original(argv);
    const r = await backup(m, "run");
    expect(r.code).toBe(1);
    expect(r.err).toContain("restic cannot open the repository (exit 12)");
    expect(r.err).toContain("wrong password");
    expect(resticCalls(m).map((c) => c[1])).toEqual(["cat"]);
  });

  test("a failed backup skips the prune", async () => {
    const { m } = fixture();
    const original = m.respond;
    m.respond = (argv) =>
      argv[1] === "backup" ? { code: 1, stdout: "", stderr: "boom" } : original(argv);
    const r = await backup(m, "run");
    expect(r.code).toBe(1);
    expect(resticCalls(m).map((c) => c[1])).toEqual(["cat", "init", "backup"]);
  });

  test("a database too busy for .backup is snapshotted with VACUUM INTO instead", async () => {
    const { m } = fixture();
    const original = m.respond;
    const busy = `${m.home}/.codex/state.sqlite`;
    m.respond = (argv) =>
      argv[0] === "sqlite3" && argv.at(-2) === busy && argv.at(-1)?.startsWith(".backup")
        ? { code: 124, stdout: "", stderr: "" }
        : original(argv);
    const r = await backup(m, "run");
    expect(r.code).toBe(0);
    expect(r.err).toContain(`${busy} changes too fast for .backup, using VACUUM INTO`);
    const vacuums = m.calls.filter((c) => c[0] === "sqlite3" && c.at(-1)?.startsWith("vacuum"));
    expect(vacuums).toEqual([
      ["sqlite3", busy, `vacuum into '${stateDir(m)}/sqlite.tmp/codex/state.sqlite'`],
    ]);
    expect(existsSync(join(stateDir(m), "sqlite/codex/state.sqlite"))).toBe(true);
  });

  test("a snapshot that fails quick_check stops the run before restic is touched", async () => {
    const { m } = fixture();
    const original = m.respond;
    m.respond = (argv) =>
      argv[0] === "sqlite3" && argv.at(-1) === "pragma quick_check"
        ? { code: 0, stdout: "*** in database main ***\n", stderr: "" }
        : original(argv);
    const r = await backup(m, "run");
    expect(r.code).toBe(1);
    expect(r.err).toContain("failed quick_check");
    expect(resticCalls(m)).toEqual([]);
  });

  test("with no source on disk it fails instead of backing up nothing", async () => {
    const { m } = fixture();
    sourcesFile(m.home, "grok ~/.grok\n");
    const r = await backup(m, "run");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no source in");
    expect(resticCalls(m)).toEqual([]);
  });

  test("a second run replaces the staged snapshots", async () => {
    const { m } = fixture();
    await backup(m, "run");
    write(join(stateDir(m), "sqlite/stale/old.db"), "stale");
    await backup(m, "run");
    expect(existsSync(join(stateDir(m), "sqlite/stale"))).toBe(false);
    expect(existsSync(join(stateDir(m), "sqlite/codex/state.sqlite"))).toBe(true);
  });

  test("two runs never overlap", async () => {
    const { m } = fixture();
    const lock = join(stateDir(m), "lock");
    m.processes.push({ pid: 4242, argv: ["devbox", "backup", "run"] });
    write(lock, "4242\n");
    const busy = await backup(m, "run");
    expect(busy.code).toBe(1);
    expect(busy.err).toContain("another devbox backup is running (pid 4242)");
    expect(resticCalls(m)).toEqual([]);
    expect(readFileSync(lock, "utf8")).toBe("4242\n");

    m.processes.length = 0;
    const after = await backup(m, "run");
    expect(after.code).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  test("the lock is released when the run fails", async () => {
    const { m } = fixture();
    const original = m.respond;
    m.respond = (argv) =>
      argv[1] === "backup" ? { code: 1, stdout: "", stderr: "" } : original(argv);
    await backup(m, "run");
    expect(existsSync(join(stateDir(m), "lock"))).toBe(false);
  });
});

describe("devbox backup verify", () => {
  test("restores the staged snapshots and opens each one", async () => {
    const { m } = fixture();
    await backup(m, "run");
    m.calls.length = 0;
    const r = await backup(m, "verify");
    expect(r.code).toBe(0);
    expect(r.err).toContain("verify ok: 3 sqlite files restored and readable");
    const restore = resticCalls(m).find((c) => c[1] === "restore")!;
    expect(restore.slice(0, 6)).toEqual([
      "restic",
      "restore",
      "latest",
      "--tag",
      "agent-backup",
      "--target",
    ]);
    expect(restore.at(-2)).toBe("--include");
    expect(restore.at(-1)).toBe(join(stateDir(m), "sqlite"));
    expect(resticCalls(m)[0]).toEqual(["restic", "check"]);
    const target = restore[6]!;
    expect(existsSync(target)).toBe(false);
  });

  test("fails when the snapshot holds no SQLite file", async () => {
    const { m } = fixture();
    const r = await backup(m, "verify");
    expect(r.code).toBe(1);
    expect(r.err).toContain("holds no sqlite snapshot");
  });

  test("fails when a restored file fails quick_check", async () => {
    const { m } = fixture();
    await backup(m, "run");
    const original = m.respond;
    m.respond = (argv) =>
      argv[0] === "sqlite3" && argv[1]?.includes("/verify-")
        ? { code: 0, stdout: "database disk image is malformed\n", stderr: "" }
        : original(argv);
    const r = await backup(m, "verify");
    expect(r.code).toBe(1);
    expect(r.err).toContain("failed quick_check");
  });

  test("fails when restic check fails", async () => {
    const { m } = fixture();
    await backup(m, "run");
    const original = m.respond;
    m.respond = (argv) =>
      argv[1] === "check" ? { code: 1, stdout: "", stderr: "pack damaged" } : original(argv);
    const r = await backup(m, "verify");
    expect(r.code).toBe(1);
    expect(r.err).toContain("restic check exited with 1");
  });
});

const plan = (live: string) => ({
  stage: absolutePath("/stage"),
  sources: [],
  snapshots: [{ source: "s", live, entry: "s/x.db" }],
});

describe("what goes into the exclude file and the sqlite shell", () => {
  test("glob characters are escaped and a $ is doubled, because restic expands $VARS", () => {
    expect(excludeFile(plan("/h/a[1]/b*$c.db")).split("\n")).toEqual([
      "/h/a\\[1]/b\\*$$c.db",
      "/h/a\\[1]/b\\*$$c.db-wal",
      "/h/a\\[1]/b\\*$$c.db-shm",
      "/h/a\\[1]/b\\*$$c.db-journal",
      "",
    ]);
  });

  test("the .backup target is quoted for the sqlite shell", () => {
    expect(sqliteBackupArgs("/h/live.db", `/s/it's a "dir"/x.db`).at(-1)).toBe(
      `.backup "/s/it's a \\"dir\\"/x.db"`,
    );
  });

  test("the header is the 16 bytes SQLite writes, nothing shorter", () => {
    const header = new TextEncoder().encode("SQLite format 3\0");
    expect(hasSqliteHeader(header)).toBe(true);
    expect(hasSqliteHeader(header.subarray(0, 15))).toBe(false);
    expect(hasSqliteHeader(new TextEncoder().encode("SQLite format 4\0"))).toBe(false);
    expect(hasSqliteHeader(new Uint8Array())).toBe(false);
  });
});
