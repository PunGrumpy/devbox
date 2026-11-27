import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer, Option } from "effect";

import { ClaudeFiles } from "../src/migrate/claude-files.ts";
import { ClaudeHomes } from "../src/migrate/claude-homes.ts";
import { Locations } from "../src/migrate/locations.ts";
import { absolutePath } from "../src/migrate/paths.ts";
import { Output } from "../src/output.ts";
import {
  addProject,
  makeWorld,
  putFiles,
  query,
  slug,
  snapshot,
  type World,
} from "./support/fixture.ts";
import { migrate } from "./support/run.ts";

const runIn = (world: World, ...args: string[]) => migrate(world.env, ...args);

const OLD = new Date("2020-01-02T03:04:05Z");

const dotfiles = () => {
  const w = makeWorld();
  const root = join(w.home, ".dotfiles");
  mkdirSync(root);
  const to = join(w.home, "Developments", "dotfiles");
  addProject(w, "p1", "dotfiles", root, [
    { cwd: root },
    { cwd: `${root}/sub` },
    { cwd: `${root}/` },
    { cwd: `${root}c` },
    { cwd: `${root}/codex-only`, driver: "codex" },
  ]);

  const from = (home: string, extra = "") =>
    join(home, "projects", slug(root) + extra);

  const dest = (home: string, extra = "") =>
    join(home, "projects", slug(join(w.real, "dotfiles")) + extra);

  const seed = (home: string, tag: string) => {
    putFiles(from(home), {
      "a.jsonl": `${tag} transcript`,
      "memory/MEMORY.md": `${tag} index`,
      "memory/x.md": `${tag} x`,
      "s1/sub/deep.jsonl": `${tag} deep`,
    });
    symlinkSync(join(from(home), "a.jsonl"), join(from(home), "link.jsonl"));
    utimesSync(join(from(home), "a.jsonl"), OLD, OLD);
    putFiles(from(home, "-sub"), { "b.jsonl": `${tag} sub` });
    putFiles(from(home, "-codex-only"), {
      "never.jsonl": "codex sessions are not copied",
    });
    putFiles(from(home, "c"), {
      "never.jsonl": "a sibling path is not beneath the root",
    });
  };

  seed(w.homes.a, "A");
  seed(w.homes.b, "B");

  const rename = (...extra: string[]) =>
    runIn(w, "rename-root", "--project", "p1", "--to", to, ...extra);

  const currentRoot = () =>
    query<{ r: string }>(
      w.db,
      "SELECT workspace_root AS r FROM projection_projects"
    )[0]!.r;

  return { w, root, to, from, dest, rename, workspaceRoot: currentRoot };
};

describe("rename-root carries Claude files", () => {
  test("copies to the realpath slug, per home, and leaves the source alone", async () => {
    const d = dotfiles();
    const before = snapshot(d.w.homes.a);
    const beforeB = snapshot(d.w.homes.b);
    const r = await d.rename("--apply", "--yes");
    expect(r.code).toBe(0);
    expect(r.err).toContain("> Success!");
    expect(d.workspaceRoot()).toBe(d.to);

    expect(existsSync(join(d.w.homes.a, "projects", slug(d.to)))).toBe(false);

    for (const [home, tag] of [
      [d.w.homes.a, "A"],
      [d.w.homes.b, "B"],
    ] as const) {
      expect(readFileSync(join(d.dest(home), "a.jsonl"), "utf8")).toBe(
        `${tag} transcript`
      );
      expect(readFileSync(join(d.dest(home), "memory", "x.md"), "utf8")).toBe(
        `${tag} x`
      );
      expect(
        readFileSync(join(d.dest(home), "s1/sub/deep.jsonl"), "utf8")
      ).toBe(`${tag} deep`);
      expect(readFileSync(join(d.dest(home, "-sub"), "b.jsonl"), "utf8")).toBe(
        `${tag} sub`
      );
      expect(existsSync(join(d.dest(home), "link.jsonl"))).toBe(false);
      expect(
        Math.abs(
          lstatSync(join(d.dest(home), "a.jsonl")).mtimeMs - OLD.getTime()
        )
      ).toBeLessThan(2);
      expect(existsSync(d.dest(home, "-codex-only"))).toBe(false);
      expect(existsSync(d.dest(home, "c"))).toBe(false);
    }

    expect(r.err).toContain("1 symlink or special file skipped");
    expect(r.err).toContain("claudeAgent_a, claudeAgent_a_again");
    expect(r.err).toContain("claudeAgent_b, claudeAgent_b_alias");
    expect(r.err).not.toContain("slug format");

    const afterA = snapshot(d.w.homes.a);

    for (const [path, value] of Object.entries(before)) {
      expect(afterA[path]).toBe(value);
    }

    for (const [path, value] of Object.entries(beforeB)) {
      expect(snapshot(d.w.homes.b)[path]).toBe(value);
    }

    expect(
      Object.keys(afterA).filter((p) => !(p in before)).length
    ).toBeGreaterThan(0);
  });

  test("two homes stay separate: a file missing in one is not borrowed from the other", async () => {
    const d = dotfiles();
    putFiles(d.from(d.w.homes.a), { "only-in-a.jsonl": "A" });
    expect((await d.rename("--apply", "--yes")).code).toBe(0);
    expect(existsSync(join(d.dest(d.w.homes.a), "only-in-a.jsonl"))).toBe(true);
    expect(existsSync(join(d.dest(d.w.homes.b), "only-in-a.jsonl"))).toBe(
      false
    );
    expect(readFileSync(join(d.dest(d.w.homes.b), "a.jsonl"), "utf8")).toBe(
      "B transcript"
    );
  });

  test("dry run lists homes, counts, bytes and destination, and writes nothing", async () => {
    const d = dotfiles();
    const before = snapshot(d.w.base);
    const r = await d.rename();
    expect(r.code).toBe(0);
    expect(r.err).toContain(`${d.w.homes.a}`);
    expect(r.err).toContain(`${d.w.homes.b}`);
    expect(r.err).toContain(d.dest(d.w.homes.a));
    expect(r.err).toContain(d.dest(d.w.homes.b));
    expect(r.err).toMatch(
      /4 files to copy \(\d+ B\), 0 already there, 0 conflicts/
    );
    expect(r.err).toContain("NOTE: dry run");
    expect(snapshot(d.w.base)).toEqual(before);
  });

  test("--db is a rehearsal on a copy: nothing is copied, and it says so", async () => {
    const d = dotfiles();
    const copy = join(d.w.base, "rehearsal.sqlite");
    copyFileSync(d.w.db, copy);
    const before = snapshot(d.w.homes.a);

    const r = await runIn(
      d.w,
      "rename-root",
      "--db",
      copy,
      "--project",
      "p1",
      "--to",
      d.to,
      "--apply",
      "--yes"
    );

    expect(r.code).toBe(0);
    expect(r.err).toContain(
      "NOTE: --db points at a copy, so Claude transcripts and memory are not copied"
    );
    expect(snapshot(d.w.homes.a)).toEqual(before);
    expect(existsSync(d.dest(d.w.homes.b))).toBe(false);
    expect(
      query<{ r: string }>(
        copy,
        "SELECT workspace_root AS r FROM projection_projects"
      )[0]!.r
    ).toBe(d.to);
    expect(d.workspaceRoot()).toBe(d.root);
  });

  test("--db spelling the live database is not a copy, so the files are copied", async () => {
    const d = dotfiles();

    const r = await runIn(
      d.w,
      "rename-root",
      "--db",
      d.w.db,
      "--project",
      "p1",
      "--to",
      d.to,
      "--apply",
      "--yes"
    );

    expect(r.code).toBe(0);
    expect(r.err).not.toContain("not copied");
    expect(readFileSync(join(d.dest(d.w.homes.a), "a.jsonl"), "utf8")).toBe(
      "A transcript"
    );
    expect(d.workspaceRoot()).toBe(d.to);
  });

  test("a change of spelling only has nothing to copy", async () => {
    const w = makeWorld();
    const spelled = join(w.home, "Developments", "proj");
    const real = join(w.real, "proj");
    addProject(w, "p1", "proj", spelled, [{ cwd: spelled }]);
    putFiles(join(w.homes.a, "projects", slug(real)), { "a.jsonl": "x" });
    const before = snapshot(w.homes.a);

    const r = await runIn(
      w,
      "rename-root",
      "--project",
      "p1",
      "--to",
      real,
      "--apply",
      "--yes"
    );

    expect(r.code).toBe(0);
    expect(r.err).toContain(
      "the root keeps the same Claude slug, nothing to copy"
    );
    expect(r.err).not.toContain("slug format");
    expect(r.err).not.toContain("conflict");
    expect(snapshot(w.homes.a)).toEqual(before);
    expect(
      query<{ r: string }>(
        w.db,
        "SELECT workspace_root AS r FROM projection_projects"
      )[0]!.r
    ).toBe(real);
  });

  test("a home without the old slug is skipped quietly; none at all is a WARN", async () => {
    const d = dotfiles();

    const rm = Bun.spawnSync([
      "rm",
      "-rf",
      d.from(d.w.homes.b),
      d.from(d.w.homes.b, "-sub"),
    ]);

    expect(rm.exitCode).toBe(0);
    const some = await d.rename("--apply", "--yes");
    expect(some.code).toBe(0);
    expect(some.err).not.toContain("slug format");
    expect(some.err).not.toContain(d.w.homes.b);
    expect(existsSync(d.dest(d.w.homes.a))).toBe(true);
    expect(existsSync(d.dest(d.w.homes.b))).toBe(false);

    const none = dotfiles();
    Bun.spawnSync([
      "rm",
      "-rf",
      join(none.w.homes.a, "projects"),
      join(none.w.homes.b, "projects"),
    ]);
    const r = await none.rename("--apply", "--yes");
    expect(r.code).toBe(0);
    expect(r.err).toContain("WARN! no Claude home has projects/");
    expect(r.err).toContain("the slug format may have changed");
    expect(r.err).toContain("> Success!");
    expect(none.workspaceRoot()).toBe(none.to);
  });

  test("identical files are skipped, different ones are reported and never overwritten", async () => {
    const d = dotfiles();
    putFiles(d.dest(d.w.homes.a), {
      "a.jsonl": "A transcript",
      "memory/x.md": "A y",
    });
    utimesSync(join(d.dest(d.w.homes.a), "a.jsonl"), new Date(), new Date());
    const r = await d.rename("--apply", "--yes");
    expect(r.code).toBe(0);
    expect(readFileSync(join(d.dest(d.w.homes.a), "memory/x.md"), "utf8")).toBe(
      "A y"
    );
    expect(
      readFileSync(join(d.dest(d.w.homes.a), "memory/MEMORY.md"), "utf8")
    ).toBe("A index");
    expect(readFileSync(join(d.from(d.w.homes.a), "memory/x.md"), "utf8")).toBe(
      "A x"
    );
    const conflict = join(d.dest(d.w.homes.a), "memory/x.md");
    expect(r.err).toContain("1 already there, 1 conflict");
    expect(r.err.indexOf("> Success!")).toBeLessThan(
      r.err.lastIndexOf(conflict)
    );
    expect(r.err).toContain(
      "1 file already existed with other content, or sat behind a symlink, and were left as they are"
    );
  });

  test("a symlink in the destination never redirects a write", async () => {
    const d = dotfiles();
    const elsewhere = join(d.w.homes.b, "projects", "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, d.dest(d.w.homes.a));
    mkdirSync(d.dest(d.w.homes.b), { recursive: true });
    symlinkSync(
      join(d.from(d.w.homes.b), "memory"),
      join(d.dest(d.w.homes.b), "s1")
    );
    const sourceB = snapshot(d.from(d.w.homes.b));
    const sourceA = snapshot(d.from(d.w.homes.a));
    const r = await d.rename("--apply", "--yes");
    expect(r.code).toBe(0);
    expect(snapshot(elsewhere)).toEqual({});
    expect(snapshot(d.from(d.w.homes.b))).toEqual(sourceB);
    expect(snapshot(d.from(d.w.homes.a))).toEqual(sourceA);
    expect(r.err).toContain("or sat behind a symlink");
    expect(readFileSync(join(d.dest(d.w.homes.b), "a.jsonl"), "utf8")).toBe(
      "B transcript"
    );
  });

  test("a symlinked source slug is never followed, so nothing crosses homes", async () => {
    const d = dotfiles();
    Bun.spawnSync(["rm", "-rf", d.from(d.w.homes.a)]);
    symlinkSync(d.from(d.w.homes.b), d.from(d.w.homes.a));
    const sourceB = snapshot(d.from(d.w.homes.b));
    const r = await d.rename("--apply", "--yes");
    expect(r.code).toBe(0);
    expect(r.err).toContain("is a symlink, so it is not copied");
    expect(r.err).not.toContain("slug format");
    expect(existsSync(d.dest(d.w.homes.a))).toBe(false);
    expect(readFileSync(join(d.dest(d.w.homes.b), "a.jsonl"), "utf8")).toBe(
      "B transcript"
    );
    expect(snapshot(d.from(d.w.homes.b))).toEqual(sourceB);
  });

  test("a destination slug that is a symlink to the source is left alone, without a false warning", async () => {
    const d = dotfiles();
    Bun.spawnSync([
      "rm",
      "-rf",
      d.from(d.w.homes.b),
      d.from(d.w.homes.b, "-sub"),
    ]);
    symlinkSync(d.from(d.w.homes.a), d.dest(d.w.homes.a));
    const sourceA = snapshot(d.from(d.w.homes.a));
    const r = await d.rename("--apply", "--yes");
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("slug format");
    expect(snapshot(d.from(d.w.homes.a))).toEqual(sourceA);
    expect(d.workspaceRoot()).toBe(d.to);
  });

  test("a file name near the limit still copies", async () => {
    const d = dotfiles();
    const name = `${"n".repeat(240)}.jsonl`;
    putFiles(d.from(d.w.homes.a), { [name]: "long" });
    expect((await d.rename("--apply", "--yes")).code).toBe(0);
    expect(readFileSync(join(d.dest(d.w.homes.a), name), "utf8")).toBe("long");
  });

  test("nothing is copied when the prompt is refused", async () => {
    const d = dotfiles();
    const before = snapshot(d.w.base);
    const r = await d.rename("--apply");
    expect(r.code).toBe(1);
    expect(r.err).toContain("not a terminal");
    expect(snapshot(d.w.base)).toEqual(before);
    expect(d.workspaceRoot()).toBe(d.root);
  });

  test("a session whose cwd differs only by case is another path: not rewritten, not copied", async () => {
    const d = dotfiles();
    const other = join(d.w.home, ".DOTFILES", "x");
    addProject(d.w, "p9", "upper", join(d.w.home, ".DOTFILES"), [
      { cwd: other },
    ]);
    putFiles(d.from(d.w.homes.a, "-x"), {
      "never.jsonl": "a path that differs by case",
    });
    expect((await d.rename("--apply", "--yes")).code).toBe(0);
    expect(existsSync(d.dest(d.w.homes.a, "-x"))).toBe(false);
    expect(
      query<{ cwd: string }>(
        d.w.db,
        "SELECT json_extract(payload_json, '$.cwd') AS cwd FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id = 'p9-s0'"
      )[0]!.cwd
    ).toBe(other);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a destination or home that cannot be inspected stops the run before the database",
    async () => {
      const d = dotfiles();
      mkdirSync(d.dest(d.w.homes.a));
      chmodSync(d.dest(d.w.homes.a), 0o000);

      try {
        const r = await d.rename("--apply", "--yes");
        expect(r.code).toBe(1);
        expect(r.err).toContain("Error:");
        expect(r.err).not.toContain("sat behind a symlink");
        expect(d.workspaceRoot()).toBe(d.root);
      } finally {
        chmodSync(d.dest(d.w.homes.a), 0o755);
      }

      const projects = join(d.w.homes.a, "projects");
      chmodSync(projects, 0o000);

      try {
        const r = await d.rename("--apply", "--yes");
        expect(r.code).toBe(1);
        expect(r.err).toContain("nothing was changed");
        expect(d.workspaceRoot()).toBe(d.root);
      } finally {
        chmodSync(projects, 0o755);
      }
    }
  );

  test.skipIf(process.getuid?.() === 0)(
    "an unreadable source dir is a clear error in a dry run",
    async () => {
      const d = dotfiles();
      const locked = join(d.from(d.w.homes.a), "s1");
      chmodSync(locked, 0o000);

      try {
        const r = await d.rename();
        expect(r.code).toBe(1);
        expect(r.err).toContain("nothing was changed");
      } finally {
        chmodSync(locked, 0o755);
      }
    }
  );

  test("a malformed settings.json stops the run before the database", async () => {
    const d = dotfiles();
    writeFileSync(join(d.w.t3, "userdata", "settings.json"), "{ not json");
    const r = await d.rename("--apply", "--yes");
    expect(r.code).toBe(1);
    expect(r.err).toContain("settings.json");
    expect(d.workspaceRoot()).toBe(d.root);
    const doctor = await runIn(d.w, "doctor", "--db", d.w.db);
    expect(doctor.code).toBe(0);
    expect(doctor.err).toContain("Claude memory not checked");
    expect(doctor.err).toContain(
      "✖ Claude memory under the live slug  not checked"
    );
    expect(
      JSON.parse((await runIn(d.w, "doctor", "--db", d.w.db, "--json")).out)
        .strandedMemory
    ).toBeNull();
  });

  test("only symlinked source slugs: they are skipped, and that is not a format change", async () => {
    const d = dotfiles();

    for (const home of [d.w.homes.a, d.w.homes.b]) {
      Bun.spawnSync(["rm", "-rf", d.from(home), d.from(home, "-sub")]);
      symlinkSync(join(d.w.base, "elsewhere"), d.from(home));
    }

    const r = await d.rename("--apply", "--yes");
    expect(r.code).toBe(0);
    expect(r.err).toContain("is a symlink, so it is not copied");
    expect(r.err).not.toContain("slug format");
  });

  test("the format warning is about the root: sub-only slugs do not hide it", async () => {
    const d = dotfiles();

    for (const home of [d.w.homes.a, d.w.homes.b]) {
      Bun.spawnSync(["rm", "-rf", d.from(home)]);
    }

    const r = await d.rename("--apply", "--yes");
    expect(r.code).toBe(0);
    expect(r.err).toContain("the slug format may have changed");
    expect(
      readFileSync(join(d.dest(d.w.homes.a, "-sub"), "b.jsonl"), "utf8")
    ).toBe("A sub");
  });

  test("a destination file that is a symlink is a conflict and its target is untouched", async () => {
    const d = dotfiles();
    const target = join(d.w.base, "outside.txt");
    writeFileSync(target, "outside");
    mkdirSync(d.dest(d.w.homes.a), { recursive: true });
    symlinkSync(target, join(d.dest(d.w.homes.a), "a.jsonl"));
    const r = await d.rename("--apply", "--yes");
    expect(r.code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("outside");
    expect(r.err).toContain("1 conflict");
  });

  test("a file that appears after the plan, during the prompt, is still copied", async () => {
    const d = dotfiles();
    const late = join(d.from(d.w.homes.a), "late.jsonl");

    const layer = ClaudeFiles.layer.pipe(
      Layer.provideMerge(ClaudeHomes.layer(Option.none())),
      Layer.provideMerge(Locations.layer),
      Layer.provideMerge(
        Layer.succeed(
          Output,
          Output.make({
            stdout: () => {},
            stderr: () => {},
            paint: (_, text) => text,
            stdoutColor: false,
            interactive: false,
            readAnswer: Effect.die("no terminal in tests"),
            pickMany: () => Effect.die("no terminal in tests"),
          })
        )
      ),
      Layer.provideMerge(BunServices.layer),
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: d.w.env }))
      )
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const files = yield* ClaudeFiles;

        const plan = yield* files.plan({
          from: absolutePath(d.root),
          to: absolutePath(d.to),
          cwds: [],
        });

        writeFileSync(late, "late");
        yield* files.apply(plan);
      }).pipe(Effect.provide(layer))
    );
    expect(readFileSync(join(d.dest(d.w.homes.a), "late.jsonl"), "utf8")).toBe(
      "late"
    );
  });

  test("a symlink to a volume that is not mounted still gives the slug it will have", async () => {
    const w = makeWorld();
    const gone = join(w.base, "unmounted", "Dev2");
    symlinkSync(gone, join(w.home, "Dev2"));
    const oldRoot = join(w.home, "Dev2", "proj");
    const newRoot = join(w.home, "Dev2", "proj2");
    addProject(w, "p1", "proj", oldRoot, [{ cwd: oldRoot }]);
    putFiles(join(w.homes.a, "projects", slug(join(gone, "proj"))), {
      "a.jsonl": "live",
    });
    putFiles(join(w.homes.a, "projects", slug(oldRoot)), {
      "b.jsonl": "spelled",
    });

    const r = await runIn(
      w,
      "rename-root",
      "--project",
      "p1",
      "--to",
      newRoot,
      "--apply",
      "--yes"
    );

    expect(r.code).toBe(0);
    const dest = join(w.homes.a, "projects", slug(join(gone, "proj2")));
    expect(readFileSync(join(dest, "a.jsonl"), "utf8")).toBe("live");
    expect(existsSync(join(dest, "b.jsonl"))).toBe(false);
  });

  test("a hard link to the live database is the live database", async () => {
    const d = dotfiles();
    const alias = join(d.w.base, "alias.sqlite");
    linkSync(d.w.db, alias);

    const r = await runIn(
      d.w,
      "rename-root",
      "--db",
      alias,
      "--project",
      "p1",
      "--to",
      d.to,
      "--apply",
      "--yes"
    );

    expect(r.code).toBe(0);
    expect(r.err).not.toContain("not copied");
    expect(readFileSync(join(d.dest(d.w.homes.a), "a.jsonl"), "utf8")).toBe(
      "A transcript"
    );
  });

  test("settings.json of the wrong shape stops the run", async () => {
    const d = dotfiles();
    writeFileSync(
      join(d.w.t3, "userdata", "settings.json"),
      JSON.stringify({ providerInstances: "x" })
    );
    const r = await d.rename("--apply", "--yes");
    expect(r.code).toBe(1);
    expect(r.err).toContain("providerInstances");
    expect(d.workspaceRoot()).toBe(d.root);
  });

  test("a Claude home that does not exist here is named, and the rename still goes on", async () => {
    const d = dotfiles();

    const settings = JSON.parse(
      readFileSync(join(d.w.t3, "userdata", "settings.json"), "utf8")
    );

    const gone = join(d.w.base, "unmounted", ".claude-c");
    settings.providerInstances.claudeAgent_gone = {
      driver: "claudeAgent",
      config: { homePath: gone },
    };
    writeFileSync(
      join(d.w.t3, "userdata", "settings.json"),
      JSON.stringify(settings)
    );
    const dry = await d.rename();
    expect(dry.code).toBe(0);
    expect(dry.err).toContain(
      `Claude home ${gone} (claudeAgent_gone) does not exist here`
    );
    const r = await d.rename("--apply", "--yes");
    expect(r.code).toBe(0);
    expect(r.err.match(/does not exist here/g)).toHaveLength(1);
    expect(existsSync(gone)).toBe(false);
    expect(readFileSync(join(d.dest(d.w.homes.a), "a.jsonl"), "utf8")).toBe(
      "A transcript"
    );
  });

  test("a relative dangling link behind a symlinked parent resolves from the real parent", async () => {
    const w = makeWorld();
    symlinkSync("../gone", join(w.real, "dang"));
    const oldRoot = join(w.home, "Developments", "dang", "proj");
    const newRoot = join(w.home, "Developments", "dang", "proj2");
    addProject(w, "p1", "proj", oldRoot, [{ cwd: oldRoot }]);
    const gone = join(dirname(w.real), "gone");
    putFiles(join(w.homes.a, "projects", slug(join(gone, "proj"))), {
      "a.jsonl": "live",
    });

    const r = await runIn(
      w,
      "rename-root",
      "--project",
      "p1",
      "--to",
      newRoot,
      "--apply",
      "--yes"
    );

    expect(r.code).toBe(0);
    const dest = join(w.homes.a, "projects", slug(join(gone, "proj2")));
    expect(readFileSync(join(dest, "a.jsonl"), "utf8")).toBe("live");
  });

  test("temp files: a file named like one is left alone, and none is left behind", async () => {
    const d = dotfiles();
    putFiles(d.dest(d.w.homes.a), { ".a.jsonl.devbox-migrate.tmp": "keep" });
    putFiles(d.from(d.w.homes.a), {
      "left-over.devbox-migrate.tmp": "from an interrupted copy",
    });
    expect((await d.rename("--apply", "--yes")).code).toBe(0);

    const temps = Object.keys(snapshot(d.dest(d.w.homes.a))).filter((p) =>
      p.endsWith(".devbox-migrate.tmp")
    );

    expect(temps).toEqual([".a.jsonl.devbox-migrate.tmp"]);
    expect(
      readFileSync(
        join(d.dest(d.w.homes.a), ".a.jsonl.devbox-migrate.tmp"),
        "utf8"
      )
    ).toBe("keep");
    expect(readFileSync(join(d.dest(d.w.homes.a), "a.jsonl"), "utf8")).toBe(
      "A transcript"
    );
  });

  test("a rerun after a partial copy converges", async () => {
    const d = dotfiles();
    putFiles(d.dest(d.w.homes.a), { "a.jsonl": "A transcript" });
    writeFileSync(
      join(d.dest(d.w.homes.a), ".memory-half.devbox-migrate.tmp"),
      "A inde"
    );
    const r = await d.rename("--apply", "--yes");
    expect(r.code).toBe(0);
    expect(r.err).toContain("0 conflicts");
    expect(
      readFileSync(join(d.dest(d.w.homes.a), "memory/MEMORY.md"), "utf8")
    ).toBe("A index");
    expect(
      readFileSync(join(d.dest(d.w.homes.a), "s1/sub/deep.jsonl"), "utf8")
    ).toBe("A deep");
  });

  test.skipIf(process.getuid?.() === 0)(
    "a failed copy leaves the database untouched",
    async () => {
      const d = dotfiles();
      const projects = join(d.w.homes.a, "projects");
      chmodSync(projects, 0o555);

      try {
        const r = await d.rename("--apply", "--yes");
        expect(r.code).toBe(1);
        expect(r.err).toContain("Error: copying Claude files failed");
        expect(r.err).toContain("the database was not touched");
        expect(d.workspaceRoot()).toBe(d.root);
        expect(existsSync(d.w.env.T3_BACKUP_DIR!)).toBe(false);
      } finally {
        chmodSync(projects, 0o755);
      }

      expect((await d.rename("--apply", "--yes")).code).toBe(0);
      expect(d.workspaceRoot()).toBe(d.to);
    }
  );
});

const stranded = () => {
  const w = makeWorld();
  const spelled = join(w.home, "Developments", "proj");
  const real = join(w.real, "proj");
  addProject(w, "p1", "proj", spelled, [
    { cwd: spelled },
    { cwd: `${spelled}/sub` },
  ]);
  addProject(w, "p2", "plain", join(w.home, "plain"), [
    { cwd: join(w.home, "plain") },
  ]);
  putFiles(join(w.homes.a, "projects", slug(join(w.home, "plain"))), {
    "memory/m.md": "m",
  });
  addProject(w, "p3", "gone", join(w.home, "Developments", "gone"));
  const db = new Database(w.db, { strict: true });
  db.exec(
    "UPDATE projection_projects SET deleted_at = 'x' WHERE project_id = 'p3'"
  );
  db.close();
  putFiles(
    join(w.homes.a, "projects", slug(join(w.home, "Developments", "gone"))),
    {
      "memory/g.md": "g",
    }
  );
  putFiles(join(w.homes.a, "projects", slug(spelled)), {
    "memory/MEMORY.md": "i",
    "memory/one.md": "1",
    "memory/two.md": "2",
    "memory/notes.txt": "not markdown",
  });
  putFiles(join(w.homes.a, "projects", slug(real)), {
    "memory/MEMORY.md": "i",
  });
  putFiles(join(w.homes.a, "projects", slug(`${spelled}/sub`)), {
    "memory/sub.md": "s",
  });
  addProject(w, "p4", "sibling", join(w.home, "elsewhere"), [
    { cwd: `${spelled}c/x` },
  ]);
  putFiles(join(w.homes.a, "projects", slug(`${spelled}c/x`)), {
    "memory/z.md": "z",
  });
  putFiles(join(w.homes.a, "projects", "-tmp-scratch-1234"), {
    "memory/s.md": "s",
  });
  putFiles(join(w.homes.b, "projects", "-unrelated"), { "memory/u.md": "u" });

  return { w, spelled, real };
};

describe("doctor reports memory stranded by a symlink spelling", () => {
  test("--json lists, per home, the files missing from the live slug", async () => {
    const { w, spelled, real } = stranded();
    const r = await runIn(w, "doctor", "--db", w.db, "--json");
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.strandedMemory).toEqual([
      {
        project: "proj",
        projectId: "p1",
        home: w.homes.a,
        cwd: spelled,
        unresolvedSlug: slug(spelled),
        liveSlug: slug(real),
        files: 3,
        missing: 2,
        liveFiles: 1,
      },
      {
        project: "proj",
        projectId: "p1",
        home: w.homes.a,
        cwd: `${spelled}/sub`,
        unresolvedSlug: slug(`${spelled}/sub`),
        liveSlug: slug(`${real}/sub`),
        files: 1,
        missing: 1,
        liveFiles: 0,
      },
    ]);
  });

  test("the report says not to delete, and finds nothing on a clean machine", async () => {
    const { w } = stranded();
    const r = await runIn(w, "doctor", "--db", w.db);
    expect(r.code).toBe(0);
    expect(r.err).toContain(
      "✖ Claude memory under the live slug  3 files only under a symlink spelling"
    );
    expect(r.err).toContain("Delete none of them");
    const clean = makeWorld();
    const ok = await runIn(clean, "doctor", "--db", clean.db, "--json");
    expect(JSON.parse(ok.out).strandedMemory).toEqual([]);
  });

  test("a cwd with a trailing slash is the same path", async () => {
    const { w, spelled } = stranded();
    const db = new Database(w.db, { strict: true });
    db.query(
      "INSERT INTO orchestration_v2_projection_provider_sessions (provider_session_id, thread_id, payload_json, driver) VALUES ('slash', 't', ?, 'claudeAgent')"
    ).run(JSON.stringify({ cwd: `${spelled}/deep/` }));
    db.close();
    putFiles(join(w.homes.a, "projects", slug(`${spelled}/deep`)), {
      "memory/d.md": "d",
    });

    const found = JSON.parse(
      (await runIn(w, "doctor", "--db", w.db, "--json")).out
    ).strandedMemory;

    expect(found.map((m: { cwd: string }) => m.cwd)).toContain(
      `${spelled}/deep`
    );
  });

  test("a session with a non-text cwd does not crash the report", async () => {
    const { w } = stranded();
    const db = new Database(w.db, { strict: true });
    db.query(
      "INSERT INTO orchestration_v2_projection_provider_sessions (provider_session_id, thread_id, payload_json, driver) VALUES ('odd', 't', '{\"cwd\":123}', 'claudeAgent')"
    ).run();
    db.close();
    expect((await runIn(w, "doctor", "--db", w.db, "--json")).code).toBe(0);
  });

  test("writes nothing", async () => {
    const { w } = stranded();
    const before = snapshot(w.base);
    expect((await runIn(w, "doctor", "--db", w.db)).code).toBe(0);
    expect((await runIn(w, "doctor", "--db", w.db, "--json")).code).toBe(0);
    expect(snapshot(w.base)).toEqual(before);
    expect(existsSync(join(w.base, "backups"))).toBe(false);
  });
});

describe("Claude homes", () => {
  test("--claude-home is where instances without a homePath live", async () => {
    const d = dotfiles();
    const custom = join(d.w.base, "custom-claude");
    putFiles(join(custom, "projects", slug(d.root)), { "c.jsonl": "custom" });
    expect(
      (await d.rename("--claude-home", custom, "--apply", "--yes")).code
    ).toBe(0);
    expect(readFileSync(join(d.dest(custom), "c.jsonl"), "utf8")).toBe(
      "custom"
    );
  });

  test("doctor warns when CLAUDE_CONFIG_DIR differs from the home it reads", async () => {
    const w = makeWorld();
    const elsewhere = join(w.base, "elsewhere");
    const env = { ...w.env, CLAUDE_CONFIG_DIR: elsewhere };
    const warned = await migrate(env, "doctor", "--db", w.db);
    expect(warned.code).toBe(0);
    expect(warned.err).toContain(
      `WARN! CLAUDE_CONFIG_DIR is ${elsewhere} here`
    );

    const matched = await migrate(
      env,
      "doctor",
      "--db",
      w.db,
      "--claude-home",
      elsewhere
    );

    expect(matched.err).not.toContain("CLAUDE_CONFIG_DIR");
    expect((await migrate(w.env, "doctor", "--db", w.db)).err).not.toContain(
      "CLAUDE_CONFIG_DIR"
    );
  });
});
