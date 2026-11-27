import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";

import { DEFAULT_SOURCES, parseEnv } from "../src/backup/config.ts";
import { excludedBy, expandVars } from "../src/backup/exclude.ts";
import {
  excludeFile,
  hasSqliteHeader,
  parseSources,
  snapshotOf,
  sqliteBackupArgs,
} from "../src/backup/model.ts";
import { Host, TIMED_OUT } from "../src/machine/host.ts";
import { absolutePath } from "../src/migrate/paths.ts";
import {
  envFile,
  makeSqlite,
  sourcesFile,
  withBackupTools,
  write,
} from "./support/backup.ts";
import { makeMachine } from "./support/host.ts";
import { devbox } from "./support/run.ts";

const backup = (m: ReturnType<typeof makeMachine>, ...args: Array<string>) =>
  devbox({ HOME: m.home, PATH: "/usr/bin:/bin" }, ["backup", ...args], {
    host: m.host,
  });

const ENV = `RESTIC_REPOSITORY=s3:https://acct.r2.cloudflarestorage.com/bucket/box
RESTIC_PASSWORD=hunter2-password
AWS_ACCESS_KEY_ID=AKIAEXAMPLEKEY
AWS_SECRET_ACCESS_KEY=topsecretvalue
AWS_DEFAULT_REGION=auto
`;

const stateDir = (m: ReturnType<typeof makeMachine>) =>
  join(m.home, ".local/state/devbox/backup");

const fixture = () => {
  const m = makeMachine();
  const repo = withBackupTools(m);
  envFile(m.home, ENV);
  write(join(m.home, ".config/devbox/backup/excludes"), "node_modules\n");
  makeSqlite(join(m.home, ".codex/state.sqlite"), 3, true);
  makeSqlite(join(m.home, ".codex/logs_1.sqlite"), 1);
  write(
    join(m.home, ".codex/notes.sqlite"),
    "this is not a database, only named like one\n"
  );
  write(join(m.home, ".codex/rollout/session.jsonl"), '{"a":1}\n');
  makeSqlite(join(m.home, ".gemini/tmp/abc/chat.db"), 2);
  write(join(m.home, ".gemini/cache.db"), "plain text in a .db file\n");
  write(join(m.home, ".gemini/empty.db"), "");
  write(join(m.home, ".claude.json"), '{"projects":{}}\n');
  symlinkSync(
    join(m.home, ".codex/state.sqlite"),
    join(m.home, ".gemini/link.db")
  );
  sourcesFile(
    m.home,
    `# agents
codex   ~/.codex
gemini  ~/.gemini
claude-json ~/.claude.json
grok    ~/.grok
`
  );

  return { m, repo };
};

const resticCalls = (m: ReturnType<typeof makeMachine>) =>
  m.calls.filter((argv) => argv[0] === "restic");

const forgetCall = (m: ReturnType<typeof makeMachine>) =>
  resticCalls(m).find((c) => c[1] === "forget")!;

const excludes = (m: ReturnType<typeof makeMachine>, text: string) =>
  write(join(m.home, ".config/devbox/backup/excludes"), text);

const restoredAt = (
  m: ReturnType<typeof makeMachine>,
  target: string,
  rel: string
) => join(target, m.home, rel);

const onRestore = (m: ReturnType<typeof makeMachine>, also: () => void) => {
  const respond = m.respond;
  m.respond = (argv) => {
    const ran = respond(argv);

    if (argv[0] === "restic" && argv[1] === "restore") {
      also();
    }
    return ran;
  };
};

const rows = (path: string) =>
  new Database(path).query("select count(*) as n from t").get();

const snapshotNames = (m: ReturnType<typeof makeMachine>) =>
  m.calls
    .filter((c) => c[0] === "sqlite3" && c.at(-1)?.startsWith(".backup"))
    .map((c) => c.at(-2)!.slice(m.home.length + 1))
    .toSorted();

describe("the sources file", () => {
  test("is read as `<name> <path>` lines, with ~ expanded and comments ignored", () => {
    const home = absolutePath("/home/agent");

    const parsed = parseSources(
      "# agents\n\ncodex ~/.codex\nroot  /srv/data\nhome ~\nspaced   /srv/with space/dir  \n",
      home
    );

    expect(parsed.issues).toEqual([]);
    expect(
      parsed.sources.map(({ name, path }) => ({ name, path: String(path) }))
    ).toEqual([
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
    const parsed = parseSources(
      `ok /srv/ok\n${line}\n`,
      absolutePath("/home/agent")
    );

    expect(parsed.sources.map((s) => s.name)).toEqual(["ok"]);
    expect(parsed.issues.map((i) => i.line)).toEqual([2]);
  });

  test("rejects a name used twice, because both would stage into one folder", () => {
    const parsed = parseSources(
      "a /srv/one\na /srv/two\n",
      absolutePath("/home/agent")
    );

    expect(parsed.issues).toEqual([
      { line: 2, why: "the name a is already used" },
    ]);
  });

  test("`backup sources` lists existing paths on stdout and notes the missing ones", async () => {
    const { m } = fixture();
    const r = await backup(m, "sources");
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `codex\t${m.home}/.codex\ngemini\t${m.home}/.gemini\nclaude-json\t${m.home}/.claude.json\n`
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
    expect(readFileSync(join(dir, "excludes"), "utf8")).toContain(
      "$HOME/.codex/logs_*.sqlite*"
    );
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
    expect(readFileSync(join(dir, "env"), "utf8")).toBe(
      "RESTIC_REPOSITORY=kept\n"
    );
    expect(statSync(join(dir, "env")).mode & 0o777).toBe(0o640);
  });

  test("the env file reads NAME=value lines and reports bad ones by number only", () => {
    expect(
      parseEnv(
        "# c\nA=1\nB = two words \nC='quoted value'\nD=\"x=y\"\nnot a pair\n9X=1\n"
      )
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
      ].toSorted()
    );

    const stage = join(stateDir(m), "sqlite");

    for (const staged of [
      "codex/state.sqlite",
      "codex/logs_1.sqlite",
      "gemini/tmp/abc/chat.db",
    ]) {
      expect(existsSync(join(stage, staged))).toBe(true);
    }
    for (const absent of [
      "codex/notes.sqlite",
      "gemini/cache.db",
      "gemini/empty.db",
      "gemini/link.db",
      "codex/rollout/session.jsonl",
      "claude-json/.claude.json",
    ]) {
      expect(existsSync(join(stage, absent))).toBe(false);
    }
    expect(existsSync(`${stage}.tmp`)).toBe(false);
    expect(r.err).toContain(`skip grok: ${m.home}/.grok not found`);
    expect(r.err).toContain("sqlite snapshots: 3");
  });

  test("excludes each live database and its -wal, -shm and -journal from restic", async () => {
    const { m } = fixture();
    await backup(m, "run");

    const lines = readFileSync(
      join(stateDir(m), "sqlite-excludes"),
      "utf8"
    ).split("\n");

    const live = [
      `${m.home}/.codex/state.sqlite`,
      `${m.home}/.codex/logs_1.sqlite`,
      `${m.home}/.gemini/tmp/abc/chat.db`,
    ];

    expect(lines.filter((l) => l !== "").toSorted()).toEqual(
      [
        ...live.flatMap((p) => [p, `${p}-wal`, `${p}-shm`, `${p}-journal`]),
        "*.sqlite-wal",
        "*.sqlite-shm",
        "*.db-wal",
        "*.db-shm",
      ].toSorted()
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
        "--host",
        "box-1.example.internal",
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
    expect(resticCalls(m).map((c) => c[1])).toEqual([
      "cat",
      "backup",
      "forget",
    ]);
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

    for (const secret of [
      "hunter2-password",
      "topsecretvalue",
      "AKIAEXAMPLEKEY",
    ]) {
      expect(r.out).not.toContain(secret);
      expect(r.err).not.toContain(secret);
    }
  });

  test("a repository restic cannot open is an error, not a new repository", async () => {
    const { m } = fixture();
    const original = m.respond;
    m.respond = (argv) =>
      argv[1] === "cat"
        ? {
            code: 12,
            stdout: "",
            stderr: "Fatal: wrong password or no key found\n",
          }
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
      argv[1] === "backup"
        ? { code: 1, stdout: "", stderr: "boom" }
        : original(argv);
    const r = await backup(m, "run");
    expect(r.code).toBe(1);
    expect(resticCalls(m).map((c) => c[1])).toEqual(["cat", "init", "backup"]);
  });

  test("a database too busy for .backup is snapshotted with VACUUM INTO instead", async () => {
    const { m } = fixture();
    const original = m.respond;
    const busy = `${m.home}/.codex/state.sqlite`;
    m.respond = (argv) =>
      argv[0] === "sqlite3" &&
      argv.at(-2) === busy &&
      argv.at(-1)?.startsWith(".backup")
        ? { code: 124, stdout: "", stderr: "" }
        : original(argv);
    const r = await backup(m, "run");
    expect(r.code).toBe(0);
    expect(r.err).toContain(
      `${busy} changes too fast for .backup, using VACUUM INTO`
    );

    const vacuums = m.calls.filter(
      (c) => c[0] === "sqlite3" && c.at(-1)?.startsWith("vacuum")
    );

    expect(vacuums).toEqual([
      [
        "sqlite3",
        "-cmd",
        ".timeout 30000",
        busy,
        `vacuum into '${stateDir(m)}/sqlite.tmp/codex/state.sqlite'`,
      ],
    ]);

    const timeouts = m.runs
      .filter((c) => c.argv.at(-1)?.startsWith("vacuum"))
      .map((c) => c.timeoutMs);

    expect(timeouts).toEqual([120_000]);
    expect(existsSync(join(stateDir(m), "sqlite/codex/state.sqlite"))).toBe(
      true
    );
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
    expect(existsSync(join(stateDir(m), "sqlite/codex/state.sqlite"))).toBe(
      true
    );
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

  test("a lock whose pid now belongs to another program is stale", async () => {
    const { m } = fixture();
    const lock = join(stateDir(m), "lock");
    m.processes.push({ pid: 4242, argv: ["/usr/bin/python3", "serve.py"] });
    write(lock, "4242\n");
    const r = await backup(m, "run");
    expect(r.code).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  test.each([[""], ["not a pid\n"]])(
    "a just-written lock holding %p may belong to a writer that has not flushed yet",
    async (content) => {
      const { m } = fixture();
      const lock = join(stateDir(m), "lock");
      write(lock, content);
      const r = await backup(m, "run");
      expect(r.code).toBe(1);
      expect(r.err).toContain("another devbox backup is starting");
      expect(resticCalls(m)).toEqual([]);
      expect(existsSync(lock)).toBe(true);
    }
  );

  test.each([[""], ["not a pid\n"]])(
    "a lock holding %p that has sat for a minute is stale",
    async (content) => {
      const { m } = fixture();
      const lock = join(stateDir(m), "lock");
      write(lock, content);
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      const r = await backup(m, "run");
      expect(r.code).toBe(0);
      expect(existsSync(lock)).toBe(false);
    }
  );

  test("the lock is released when the run fails", async () => {
    const { m } = fixture();
    const original = m.respond;
    m.respond = (argv) =>
      argv[1] === "backup"
        ? { code: 1, stdout: "", stderr: "" }
        : original(argv);
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
    expect(restore.slice(0, 8)).toEqual([
      "restic",
      "restore",
      "latest",
      "--host",
      "box-1.example.internal",
      "--tag",
      "agent-backup",
      "--target",
    ]);
    expect(restore.at(-2)).toBe("--include");
    expect(restore.at(-1)).toBe(join(stateDir(m), "sqlite"));
    expect(resticCalls(m)[0]).toEqual(["restic", "check"]);
    const target = restore[8]!;
    expect(existsSync(target)).toBe(false);
  });

  test("a snapshot with no SQLite file passes restic check and says so", async () => {
    const { m } = fixture();
    sourcesFile(m.home, "claude-json ~/.claude.json\n");
    await backup(m, "run");
    m.calls.length = 0;
    const r = await backup(m, "verify");
    expect(r.code).toBe(0);
    expect(r.err).toContain("holds no sqlite file");
    expect(r.err).toContain("verify ok");
    expect(resticCalls(m).map((c) => c[1])).toEqual(["check", "restore"]);
  });

  test("fails when the repository holds no snapshot", async () => {
    const { m } = fixture();
    const r = await backup(m, "verify");
    expect(r.code).toBe(1);
    expect(r.err).toContain("restic restore exited with 1");
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
      argv[1] === "check"
        ? { code: 1, stdout: "", stderr: "pack damaged" }
        : original(argv);
    const r = await backup(m, "verify");
    expect(r.code).toBe(1);
    expect(r.err).toContain("restic check exited with 1");
  });
});

describe("one repository shared by several machines", () => {
  test("forget only considers snapshots recorded by this machine", async () => {
    const { m } = fixture();
    await backup(m, "run");
    const forget = forgetCall(m);
    expect(forget[forget.indexOf("--host") + 1]).toBe("box-1.example.internal");
    expect(forget[forget.indexOf("--group-by") + 1]).toBe("host,tags");
  });

  test("RESTIC_HOST in the env file names the host for backup, forget, verify and restore", async () => {
    const { m } = fixture();
    envFile(m.home, `${ENV}RESTIC_HOST=vps-2\n`);
    await backup(m, "run");
    await backup(m, "verify");
    await backup(m, "restore", join(m.base, "out"));

    const hosts = resticCalls(m)
      .filter((c) => ["forget", "restore"].includes(c[1]!))
      .map((c) => c[c.indexOf("--host") + 1]);

    expect(hosts).toEqual(["vps-2", "vps-2", "vps-2"]);

    for (const run of m.runs.filter((r) => r.argv[0] === "restic")) {
      expect(run.env?.RESTIC_HOST).toBe("vps-2");
    }
  });

  test("verify restores the latest snapshot of this machine only", async () => {
    const { m } = fixture();
    await backup(m, "run");
    await backup(m, "verify");
    const restore = resticCalls(m).find((c) => c[1] === "restore")!;
    expect(restore[restore.indexOf("--host") + 1]).toBe(
      "box-1.example.internal"
    );
  });
});

describe("what discovery leaves alone", () => {
  test("a file the excludes file names is not snapshotted", async () => {
    const { m } = fixture();
    excludes(m, "$HOME/.codex/logs_*.sqlite*\n");
    const r = await backup(m, "run");
    expect(r.code).toBe(0);
    expect(snapshotNames(m)).toEqual([
      ".codex/state.sqlite",
      ".gemini/tmp/abc/chat.db",
    ]);
    expect(existsSync(join(stateDir(m), "sqlite/codex/logs_1.sqlite"))).toBe(
      false
    );
    expect(
      readFileSync(join(stateDir(m), "sqlite-excludes"), "utf8")
    ).not.toContain("logs_1");
  });

  test("a pattern without / matches any path component, and $DEVBOX_DATA expands", async () => {
    const { m } = fixture();
    makeSqlite(join(m.home, ".gemini/node_modules/pkg/x.sqlite"), 1);
    makeSqlite(join(m.home, ".gemini/.cache/y.db"), 1);
    makeSqlite(join(m.home, ".codex/skip-me.db"), 1);
    excludes(m, "node_modules\n.cache\nskip-me.db\n$DEVBOX_DATA/.gemini/tmp\n");
    await backup(m, "run");
    expect(snapshotNames(m)).toEqual([
      ".codex/logs_1.sqlite",
      ".codex/state.sqlite",
    ]);
  });

  test("a pattern with / is a glob on the full path, and * does not cross a /", async () => {
    const { m } = fixture();
    makeSqlite(join(m.home, ".gemini/deep/er/z.db"), 1);
    excludes(m, "$HOME/.gemini/*.db\n$HOME/.gemini/deep\n");
    await backup(m, "run");
    expect(snapshotNames(m)).toEqual([
      ".codex/logs_1.sqlite",
      ".codex/state.sqlite",
      ".gemini/tmp/abc/chat.db",
    ]);
  });

  test("a directory pattern with a trailing slash excludes that directory", async () => {
    const { m } = fixture();
    makeSqlite(join(m.home, ".gemini/node_modules/pkg/x.sqlite"), 1);
    excludes(m, "node_modules/\n");
    const r = await backup(m, "run");
    expect(r.code).toBe(0);
    expect(
      existsSync(join(stateDir(m), "sqlite/gemini/node_modules/pkg/x.sqlite"))
    ).toBe(false);
  });

  test("an excluded directory is not walked", async () => {
    const { m } = fixture();
    const secret = join(m.home, ".gemini/private");
    makeSqlite(join(secret, "a.db"), 1);
    excludes(m, "$HOME/.gemini/private\n");
    chmodSync(secret, 0o000);

    try {
      const r = await backup(m, "run");
      expect(r.code).toBe(0);
      expect(r.err).not.toContain("cannot read");
    } finally {
      chmodSync(secret, 0o755);
    }
  });
});

describe("devbox backup restore", () => {
  test("puts each staged SQLite snapshot back at its live path inside the target", async () => {
    const { m } = fixture();
    makeSqlite(join(m.home, "single.sqlite"), 5);
    sourcesFile(
      m.home,
      "codex ~/.codex\ngemini ~/.gemini\nsingle ~/single.sqlite\n"
    );
    await backup(m, "run");
    const target = join(m.base, "restored");
    const r = await backup(m, "restore", target);
    expect(r.code).toBe(0);

    for (const [rel, n] of [
      [".codex/state.sqlite", 3],
      [".codex/logs_1.sqlite", 1],
      [".gemini/tmp/abc/chat.db", 2],
      ["single.sqlite", 5],
    ] as const) {
      expect(rows(restoredAt(m, target, rel))).toEqual({ n });
    }
    expect(existsSync(join(target, stateDir(m), "sqlite"))).toBe(false);
    expect(r.err).toContain(`${target}${m.home}/.codex`);
    expect(r.err).toContain(`-> ${m.home}/.codex`);
    expect(r.err).toContain("-wal");
  });

  test("runs restic restore for this host and tag, into the target", async () => {
    const { m } = fixture();
    await backup(m, "run");
    const target = join(m.base, "restored");
    await backup(m, "restore", target);
    expect(resticCalls(m).find((c) => c[1] === "restore")).toEqual([
      "restic",
      "restore",
      "latest",
      "--host",
      "box-1.example.internal",
      "--tag",
      "agent-backup",
      "--target",
      target,
    ]);
    await backup(m, "restore", `${target}-2`, "--snapshot", "1a2b3c4d");
    expect(resticCalls(m).filter((c) => c[1] === "restore")[1]![2]).toBe(
      "1a2b3c4d"
    );
  });

  test("a snapshot id that looks like a flag is refused before restic runs", async () => {
    const { m } = fixture();
    await backup(m, "run");
    m.calls.length = 0;

    const r = await backup(
      m,
      "restore",
      join(m.base, "restored"),
      "--snapshot=-rf"
    );

    expect(r.code).toBe(1);
    expect(resticCalls(m)).toEqual([]);
  });

  test("uses the manifest from the snapshot, not the current sources file", async () => {
    const { m } = fixture();
    await backup(m, "run");
    sourcesFile(m.home, "other ~/elsewhere\n");
    const target = join(m.base, "restored");
    const r = await backup(m, "restore", target);
    expect(r.code).toBe(0);
    expect(rows(restoredAt(m, target, ".codex/state.sqlite"))).toEqual({
      n: 3,
    });
  });

  test("falls back to the sources file when the snapshot has no manifest", async () => {
    const { m } = fixture();
    makeSqlite(join(m.home, "single.sqlite"), 5);
    sourcesFile(
      m.home,
      "codex ~/.codex\ngemini ~/.gemini\nsingle ~/single.sqlite\n"
    );
    await backup(m, "run");
    rmSync(join(stateDir(m), "sqlite/.manifest.json"));
    const target = join(m.base, "restored");
    const r = await backup(m, "restore", target);
    expect(r.code).toBe(0);
    expect(rows(restoredAt(m, target, ".codex/state.sqlite"))).toEqual({
      n: 3,
    });
    expect(rows(restoredAt(m, target, ".gemini/tmp/abc/chat.db"))).toEqual({
      n: 2,
    });
    expect(rows(restoredAt(m, target, "single.sqlite"))).toEqual({ n: 5 });
  });

  test("a staged folder that no source names is reported and skipped", async () => {
    const { m } = fixture();
    await backup(m, "run");
    rmSync(join(stateDir(m), "sqlite/.manifest.json"));
    sourcesFile(m.home, "codex ~/.codex\n");
    const target = join(m.base, "restored");
    const r = await backup(m, "restore", target);
    expect(r.code).toBe(0);
    expect(r.err).toContain("no source named gemini");
    expect(rows(restoredAt(m, target, ".codex/state.sqlite"))).toEqual({
      n: 3,
    });
    expect(existsSync(restoredAt(m, target, ".gemini/tmp/abc/chat.db"))).toBe(
      false
    );
    expect(
      existsSync(join(target, stateDir(m), "sqlite/gemini/tmp/abc/chat.db"))
    ).toBe(true);
  });

  test("it refuses a target folder that already holds files", async () => {
    const { m } = fixture();
    await backup(m, "run");
    const target = join(m.base, "busy");
    write(join(target, "keep.txt"), "mine\n");
    const r = await backup(m, "restore", target);
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not empty");
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("mine\n");
  });

  test("a manifest that points outside the target writes nothing outside it", async () => {
    const { m } = fixture();
    await backup(m, "run");
    const manifest = join(stateDir(m), "sqlite/.manifest.json");
    const entries = JSON.parse(readFileSync(manifest, "utf8"));
    entries[0].relative = "../../../../../../../../escaped.sqlite";
    write(manifest, JSON.stringify(entries));
    const target = join(m.base, "deep/er/restored");
    const r = await backup(m, "restore", target);
    expect(r.code).toBe(1);
    expect(r.err).toContain("outside");
    expect(existsSync(join(m.base, "escaped.sqlite"))).toBe(false);
    expect(existsSync("/escaped.sqlite")).toBe(false);
  });

  test("a symlink in the restored files cannot lead a snapshot outside the target", async () => {
    const { m } = fixture();
    await backup(m, "run");
    const target = join(m.base, "restored");
    const outside = join(m.base, "outside");
    mkdirSync(outside, { recursive: true });
    onRestore(m, () => {
      mkdirSync(restoredAt(m, target, ""), { recursive: true });
      symlinkSync(outside, restoredAt(m, target, ".codex"));
    });
    const r = await backup(m, "restore", target);
    expect(r.code).toBe(1);
    expect(r.err).toContain("leads outside");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a -wal or -shm next to a restored database is removed", async () => {
    const { m } = fixture();
    await backup(m, "run");
    const target = join(m.base, "restored");
    const live = restoredAt(m, target, ".codex/state.sqlite");
    onRestore(m, () => {
      write(`${live}-wal`, "stale");
      write(`${live}-shm`, "stale");
    });
    await backup(m, "restore", target);
    expect(existsSync(`${live}-wal`)).toBe(false);
    expect(existsSync(`${live}-shm`)).toBe(false);
  });

  test("needs restic only, so a new machine without sqlite3 can restore", async () => {
    const { m } = fixture();
    await backup(m, "run");
    m.binaries.delete("sqlite3");
    const r = await backup(m, "restore", join(m.base, "restored"));
    expect(r.code).toBe(0);
  });

  test("an empty repository is an error", async () => {
    const { m } = fixture();
    const r = await backup(m, "restore", join(m.base, "restored"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("restic restore exited with 1");
  });
});

describe("exclude patterns", () => {
  const vars = { HOME: "/home/a", DEVBOX_DATA: "/data" };

  const excluded = (text: string, ...paths: Array<string>) =>
    paths.map(excludedBy(text, vars));

  test("$VAR, ${VAR} and $$ expand like restic, and an unset variable is empty", () => {
    expect(expandVars("$HOME/x ${DEVBOX_DATA}/y $$z $NOPE/w", vars)).toBe(
      "/home/a/x /data/y $z /w"
    );
  });

  test("a pattern without / is a glob on every path component, and nothing else", () => {
    expect(
      excluded(
        "node_modules\n*.tmp\n",
        "/h/node_modules",
        "/h/a.tmp",
        "/h/node_modules2",
        "/h/a/b"
      )
    ).toEqual([true, true, false, false]);
  });

  test("a pattern with / is a glob on the full path, so * stops at a /", () => {
    expect(
      excluded(
        "$HOME/.x/*.db\n",
        "/home/a/.x/y.db",
        "/home/a/.x/z/y.db",
        "/other/.x/y.db"
      )
    ).toEqual([true, false, false]);
    expect(excluded("/home/**/y.db\n", "/home/a/.x/z/y.db")).toEqual([true]);
  });

  test("a relative pattern with / matches at any depth", () => {
    expect(
      excluded(".t3/logs\n", "/home/a/.t3/logs", "/home/a/.t3/other")
    ).toEqual([true, false]);
  });

  test("comments, blank lines and ! lines add no pattern", () => {
    expect(
      excluded("# node_modules\n\n!keep.db\n", "/h/node_modules", "/h/keep.db")
    ).toEqual([false, false]);
  });
});

const plan = (live: string) => ({
  stage: absolutePath("/stage"),
  sources: [],
  snapshots: [snapshotOf({ name: "s", path: absolutePath("/h") }, live)],
});

describe("what goes into the exclude file and the sqlite shell", () => {
  test("glob characters are escaped and a $ is doubled, because restic expands $VARS", () => {
    expect(excludeFile(plan("/h/a[1]/b*$c.db")).split("\n")).toEqual([
      "/h/a\\[1]/b\\*$$c.db",
      "/h/a\\[1]/b\\*$$c.db-wal",
      "/h/a\\[1]/b\\*$$c.db-shm",
      "/h/a\\[1]/b\\*$$c.db-journal",
      "*.sqlite-wal",
      "*.sqlite-shm",
      "*.db-wal",
      "*.db-shm",
      "",
    ]);
  });

  test("sidecar patterns for any SQLite file are always excluded, even with no snapshot", () => {
    expect(
      excludeFile({ stage: absolutePath("/stage"), sources: [], snapshots: [] })
    ).toBe("*.sqlite-wal\n*.sqlite-shm\n*.db-wal\n*.db-shm\n");
  });

  test("the .backup target is quoted for the sqlite shell", () => {
    expect(sqliteBackupArgs("/h/live.db", `/s/it's a "dir"/x.db`).at(-1)).toBe(
      `.backup "/s/it's a \\"dir\\"/x.db"`
    );
  });

  test("the header is the 16 bytes SQLite writes, nothing shorter", () => {
    const header = new TextEncoder().encode("SQLite format 3\0");
    expect(hasSqliteHeader(header)).toBe(true);
    expect(hasSqliteHeader(header.subarray(0, 15))).toBe(false);
    expect(hasSqliteHeader(new TextEncoder().encode("SQLite format 4\0"))).toBe(
      false
    );
    expect(hasSqliteHeader(new Uint8Array())).toBe(false);
  });
});

describe("the real host", () => {
  test("reports a command that outlives timeoutMs as exit 124, and a quick failure as its own code", async () => {
    const run = (argv: ReadonlyArray<string>, timeoutMs: number) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const host = yield* Host;

          return yield* host.run(argv, { timeoutMs });
        }).pipe(Effect.provide(Host.layer))
      );

    expect((await run(["sleep", "5"], 200)).code).toBe(TIMED_OUT);
    expect((await run(["sh", "-c", "exit 3"], 5000)).code).toBe(3);
    expect((await run(["true"], 5000)).code).toBe(0);
  });
});

describe("sources with $DATA", () => {
  test("$DATA expands to devbox up --data and ~ to $HOME", () => {
    const { sources, issues } = parseSources(
      "claude $DATA/.claude\nt3 $DATA/.t3/userdata\njson ~/.claude.json\n",
      absolutePath("/home/agent"),
      "/workspace/home"
    );

    expect(issues).toEqual([]);
    expect(sources.map((s): string => s.path)).toEqual([
      "/workspace/home/.claude",
      "/workspace/home/.t3/userdata",
      "/home/agent/.claude.json",
    ]);
  });
});
