import { Effect, FileSystem, Option, Result, Schema } from "effect";
import { closeSync, openSync, readSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { MachineFile, machineFile } from "../machine/config.ts";
import { Host, TIMED_OUT } from "../machine/host.ts";
import { Locations } from "../migrate/locations.ts";
import { AbsolutePath, absolutePath, isUnderRoot } from "../migrate/paths.ts";
import { Output, plural } from "../output.ts";
import { backupPaths, ensureConfig, parseEnv } from "./config.ts";
import { type Excluded, excludedBy } from "./exclude.ts";
import {
  type BackupPlan,
  backupArgs,
  BACKUP_TIMEOUT_MS,
  entriesFromStage,
  excludeFile,
  forgetArgs,
  hasSqliteHeader,
  Manifest,
  type ManifestEntry,
  MANIFEST,
  manifestOf,
  parseSources,
  quickCheckArgs,
  restoreArgs,
  sidecars,
  snapshotOf,
  SnapshotId,
  type Source,
  type SqliteSnapshot,
  sqliteBackupArgs,
  SQLITE_HEADER,
  stagedEntry,
  vacuumIntoArgs,
} from "./model.ts";

export class BackupFailed extends Schema.TaggedError<BackupFailed>()("BackupFailed", {
  message: Schema.String,
  hint: Schema.optional(Schema.String),
}) {}

const fsFailed = (error: { readonly message: string }) =>
  new BackupFailed({ message: error.message });

const headerOf = (path: string): Uint8Array => {
  const buffer = new Uint8Array(SQLITE_HEADER.length);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
};

const isSqlite = (path: string) =>
  Effect.sync(() => hasSqliteHeader(headerOf(path))).pipe(Effect.orElseSucceed(() => false));

const walk = (
  dir: string,
  excluded: Excluded = () => false,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Output> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const out = yield* Output;
    const entries = yield* fs
      .readDirectoryEntries(dir)
      .pipe(
        Effect.catch((error) => Effect.as(out.warn(`cannot read ${dir}: ${error.message}`), [])),
      );
    const nested = yield* Effect.forEach(entries, (entry) =>
      excluded(join(dir, entry.name))
        ? Effect.succeed([])
        : entry.type === "File"
          ? Effect.succeed([join(dir, entry.name)])
          : entry.type === "Directory"
            ? walk(join(dir, entry.name), excluded)
            : Effect.succeed([]),
    );
    return nested.flat();
  });

const tools = (needed: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const missing = yield* Effect.filter(needed, (name) =>
      Effect.map(host.which(name), (found) => !found),
    );
    if (missing.length > 0)
      return yield* new BackupFailed({
        message: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not installed`,
        hint: "run `devbox up` with passwordless sudo to install them with apt, or install them yourself",
      });
  });

const prepareConfig = Effect.gen(function* () {
  const { home } = yield* Locations;
  const out = yield* Output;
  for (const created of yield* ensureConfig(home).pipe(Effect.mapError(fsFailed)))
    yield* out.note(`created ${created}`);
  return { home, paths: backupPaths(home) };
});

const dataDir = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(machineFile(home)).pipe(Effect.option);
    return Option.match(
      Option.flatMap(text, Schema.decodeUnknownOption(Schema.fromJsonString(MachineFile))),
      {
        onNone: () => home,
        onSome: (machine) => machine.data,
      },
    );
  });

const session = (needed: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const machine = yield* Host;
    const { home, paths } = yield* prepareConfig;
    const text = yield* fs.readFileString(paths.env).pipe(Effect.mapError(fsFailed));
    const { values, invalid } = parseEnv(text);
    if (invalid.length > 0)
      return yield* new BackupFailed({
        message: `${paths.env} line ${invalid.join(", ")} is not NAME=value`,
      });
    if ((values.RESTIC_REPOSITORY ?? "") === "")
      return yield* new BackupFailed({
        message: `RESTIC_REPOSITORY is not set in ${paths.env}`,
        hint: "fill in the restic and R2 variables there, then run again",
      });
    yield* tools(needed);
    yield* fs.makeDirectory(paths.state, { recursive: true }).pipe(Effect.mapError(fsFailed));
    const host = values.RESTIC_HOST || machine.hostname;
    return {
      home,
      paths,
      host,
      env: { ...values, RESTIC_HOST: host, DEVBOX_DATA: yield* dataDir(home) },
    };
  });

const LOCK_GRACE_MS = 10_000;

const withLock = <A, E, R>(path: string, work: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const host = yield* Host;
    const acquire: Effect.Effect<void, BackupFailed> = fs
      .writeFileString(path, `${process.pid}\n`, { flag: "wx" })
      .pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () =>
            Effect.gen(function* () {
              const text = (yield* fs
                .readFileString(path)
                .pipe(Effect.orElseSucceed(() => ""))).trim();
              if (/^\d+$/.test(text)) {
                const holder = Number(text);
                const running = (yield* host.processes).some(
                  (proc) => proc.pid === holder && proc.argv.includes("backup"),
                );
                if (running)
                  return yield* new BackupFailed({
                    message: `another devbox backup is running (pid ${holder})`,
                  });
              } else {
                const info = yield* fs.stat(path).pipe(Effect.option);
                const written = Option.flatMap(info, (stat) => stat.mtime);
                if (Option.exists(written, (at) => Date.now() - at.getTime() < LOCK_GRACE_MS))
                  return yield* new BackupFailed({
                    message: "another devbox backup is starting",
                  });
              }
              yield* fs.remove(path, { force: true });
              return yield* acquire;
            }),
        ),
        Effect.mapError((error) => (error instanceof BackupFailed ? error : fsFailed(error))),
      );
    return yield* Effect.acquireUseRelease(
      acquire,
      () => work,
      () => fs.remove(path, { force: true }).pipe(Effect.ignore),
    );
  });

export const resolveSources = (sources: ReadonlyArray<Source>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const out = yield* Output;
    const present: Array<Source> = [];
    for (const source of sources) {
      const real = yield* fs.realPath(source.path).pipe(Effect.option);
      if (Option.isSome(real))
        present.push({ name: source.name, path: AbsolutePath.make(real.value) });
      else yield* out.log(`skip ${source.name}: ${source.path} not found`);
    }
    return present;
  });

const readSources = Effect.gen(function* () {
  const { home } = yield* Locations;
  const fs = yield* FileSystem.FileSystem;
  const paths = backupPaths(home);
  const text = yield* fs.readFileString(paths.sources).pipe(Effect.mapError(fsFailed));
  const { sources, issues } = parseSources(text, home, yield* dataDir(home));
  if (issues.length > 0)
    return yield* new BackupFailed({
      message: `${paths.sources} has ${plural(issues.length, "line")} that cannot be read`,
      hint: issues.map((issue) => `line ${issue.line}: ${issue.why}`).join("\n"),
    });
  return sources;
});

export const loadSources = Effect.flatMap(readSources, resolveSources);

const discover = (stage: AbsolutePath, sources: ReadonlyArray<Source>, excluded: Excluded) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const snapshots: Array<SqliteSnapshot> = [];
    for (const source of sources) {
      if (excluded(source.path)) continue;
      const info = yield* fs.stat(source.path).pipe(Effect.mapError(fsFailed));
      const files = info.type === "Directory" ? yield* walk(source.path, excluded) : [source.path];
      for (const live of files) if (yield* isSqlite(live)) snapshots.push(snapshotOf(source, live));
    }
    return { stage, sources, snapshots } satisfies BackupPlan;
  });

const must = (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  options: { readonly inherit?: boolean } = {},
) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const ran = yield* host.run(argv, { env, ...options });
    if (ran.code !== 0)
      return yield* new BackupFailed({
        message: `${argv.slice(0, 2).join(" ")} exited with ${ran.code}`,
        hint: ran.stderr.trim() || undefined,
      });
    return ran;
  });

const stageSnapshots = (plan: BackupPlan, env: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const host = yield* Host;
    const out = yield* Output;
    const tmp = `${plan.stage}.tmp`;
    yield* fs.remove(tmp, { recursive: true, force: true }).pipe(Effect.mapError(fsFailed));
    yield* fs.makeDirectory(tmp, { recursive: true }).pipe(Effect.mapError(fsFailed));
    for (const snapshot of plan.snapshots) {
      const dest = join(tmp, snapshot.entry);
      yield* fs.makeDirectory(dirname(dest), { recursive: true }).pipe(Effect.mapError(fsFailed));
      // sqlite3's .backup starts over whenever another connection writes while it copies, so a very busy database never finishes.
      let taken = yield* host.run(sqliteBackupArgs(snapshot.live, dest), {
        env,
        timeoutMs: BACKUP_TIMEOUT_MS,
      });
      if (taken.code === TIMED_OUT) {
        yield* out.warn(`${snapshot.live} changes too fast for .backup, using VACUUM INTO`);
        yield* Effect.forEach(sidecars(dest), (path) => fs.remove(path, { force: true }), {
          discard: true,
        }).pipe(Effect.mapError(fsFailed));
        taken = yield* host.run(vacuumIntoArgs(snapshot.live, dest), {
          env,
          timeoutMs: BACKUP_TIMEOUT_MS,
        });
      }
      if (taken.code !== 0)
        return yield* new BackupFailed({
          message: `sqlite3 could not snapshot ${snapshot.live}`,
          hint: taken.stderr.trim() || undefined,
        });
      const checked = yield* host.run(quickCheckArgs(dest), { env });
      if (checked.stdout.trim() !== "ok")
        return yield* new BackupFailed({
          message: `snapshot of ${snapshot.live} failed quick_check`,
          hint: checked.stdout.trim() || checked.stderr.trim() || undefined,
        });
    }
    yield* fs
      .writeFileString(join(tmp, MANIFEST), `${JSON.stringify(manifestOf(plan), null, 2)}\n`)
      .pipe(Effect.mapError(fsFailed));
    yield* fs.remove(plan.stage, { recursive: true, force: true }).pipe(Effect.mapError(fsFailed));
    yield* fs.rename(tmp, plan.stage).pipe(Effect.mapError(fsFailed));
  });

const NO_REPOSITORY = "Is there a repository at the following location?";

const ensureRepository = (env: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const out = yield* Output;
    const probe = yield* host.run(["restic", "cat", "config"], { env });
    if (probe.code === 0) return;
    // restic 0.17 and later exit 10 for a missing repository. Older versions only print this question.
    if (probe.code !== 10 && !probe.stderr.includes(NO_REPOSITORY))
      return yield* new BackupFailed({
        message: `restic cannot open the repository (exit ${probe.code})`,
        hint: probe.stderr.trim() || undefined,
      });
    yield* out.log("restic: creating the repository");
    yield* must(["restic", "init"], env, { inherit: true });
  });

export const runBackup = Effect.gen(function* () {
  const out = yield* Output;
  const fs = yield* FileSystem.FileSystem;
  const { home, paths, env, host: resticHost } = yield* session(["restic", "sqlite3"]);
  yield* withLock(
    paths.lock,
    Effect.gen(function* () {
      const sources = yield* loadSources;
      if (sources.length === 0)
        return yield* new BackupFailed({ message: `no source in ${paths.sources} exists` });
      const excludes = yield* fs.readFileString(paths.excludes).pipe(Effect.mapError(fsFailed));
      const excluded = excludedBy(excludes, { ...process.env, HOME: home, ...env });
      const plan = yield* discover(paths.stage, sources, excluded);
      yield* stageSnapshots(plan, env);
      yield* fs
        .writeFileString(paths.generatedExcludes, excludeFile(plan))
        .pipe(Effect.mapError(fsFailed));
      yield* out.log(`sqlite snapshots: ${plan.snapshots.length}`);
      yield* ensureRepository(env);
      yield* must(
        backupArgs(plan, { generated: paths.generatedExcludes, user: paths.excludes }),
        env,
        { inherit: true },
      );
      yield* must(forgetArgs(resticHost), env, { inherit: true });
      yield* out.success(
        `backed up ${plural(plan.sources.length, "source")} and ${plural(plan.snapshots.length, "sqlite snapshot")}`,
      );
    }),
  );
});

export const verifyBackup = Effect.gen(function* () {
  const out = yield* Output;
  const fs = yield* FileSystem.FileSystem;
  const host = yield* Host;
  const { paths, env, host: resticHost } = yield* session(["restic", "sqlite3"]);
  yield* withLock(
    paths.lock,
    Effect.gen(function* () {
      yield* must(["restic", "check"], env, { inherit: true });
      const target = yield* fs
        .makeTempDirectory({ directory: paths.state, prefix: "verify-" })
        .pipe(Effect.mapError(fsFailed));
      yield* Effect.gen(function* () {
        yield* must(restoreArgs(resticHost, "latest", target, paths.stage), env, {
          inherit: true,
        });
        const restored = (yield* walk(target)).filter(
          (file) => file !== join(target, paths.stage, MANIFEST),
        );
        if (restored.length === 0) {
          yield* out.note("the latest snapshot holds no sqlite file, so only restic check ran");
          return yield* out.success("verify ok: the repository passed restic check");
        }
        for (const db of restored) {
          const checked = yield* host.run(quickCheckArgs(db), { env });
          if (checked.stdout.trim() !== "ok")
            return yield* new BackupFailed({
              message: `restored ${db} failed quick_check`,
              hint: checked.stdout.trim() || checked.stderr.trim() || undefined,
            });
        }
        yield* out.success(
          `verify ok: ${plural(restored.length, "sqlite file")} restored and readable`,
        );
      }).pipe(
        Effect.ensuring(fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore)),
      );
    }),
  );
});

const readManifest = (stage: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(join(stage, MANIFEST)).pipe(Effect.option);
    if (Option.isNone(text)) return Option.none<ReadonlyArray<ManifestEntry>>();
    return Option.some(
      yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(text.value).pipe(
        Effect.mapError(
          () => new BackupFailed({ message: `${join(stage, MANIFEST)} is not a backup manifest` }),
        ),
      ),
    );
  });

const entriesOf = (target: string, stage: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const out = yield* Output;
    if (!(yield* fs.exists(stage).pipe(Effect.mapError(fsFailed)))) return [];
    const manifest = yield* readManifest(stage);
    if (Option.isSome(manifest)) return manifest.value;
    yield* out.note(`${MANIFEST} is missing from the snapshot, so the sources file maps the names`);
    const sources = yield* readSources;
    const directories = new Set<string>();
    for (const source of sources) {
      const info = yield* fs.stat(join(target, source.path)).pipe(Effect.option);
      if (Option.exists(info, (found) => found.type === "Directory")) directories.add(source.name);
    }
    const staged = (yield* walk(stage)).map((file) => relative(stage, file));
    const { entries, unknown } = entriesFromStage(staged, sources, (source) =>
      directories.has(source.name),
    );
    for (const name of unknown)
      yield* out.warn(
        `no source named ${name} in the sources file, so its snapshots stay in ${stage}`,
      );
    return entries;
  });

const place = (target: AbsolutePath, stage: AbsolutePath, entries: ReadonlyArray<ManifestEntry>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(target).pipe(Effect.mapError(fsFailed));
    for (const entry of entries) {
      const from = join(stage, stagedEntry(entry));
      const to = join(target, entry.path, entry.relative);
      if (!isUnderRoot(to, target) || !isUnderRoot(from, stage) || to === target)
        return yield* new BackupFailed({
          message: `${entry.source}: ${entry.path} ${entry.relative} points outside ${target}`,
        });
      yield* fs.makeDirectory(dirname(to), { recursive: true }).pipe(Effect.mapError(fsFailed));
      const parent = yield* fs.realPath(dirname(to)).pipe(Effect.mapError(fsFailed));
      if (!isUnderRoot(parent, AbsolutePath.make(root)))
        return yield* new BackupFailed({
          message: `${dirname(to)} leads outside ${target}`,
          hint: "a symlink inside the restored files points elsewhere",
        });
      yield* Effect.forEach(sidecars(to), (path) => fs.remove(path, { force: true }), {
        discard: true,
      }).pipe(Effect.mapError(fsFailed));
      yield* fs.copyFile(from, to).pipe(Effect.mapError(fsFailed));
    }
  });

export const restoreBackup = (targetDir: string, snapshot: string) =>
  Effect.gen(function* () {
    const out = yield* Output;
    const fs = yield* FileSystem.FileSystem;
    if (Result.isFailure(Schema.decodeUnknownResult(SnapshotId)(snapshot)))
      return yield* new BackupFailed({
        message: `${snapshot} is not a snapshot id`,
        hint: "use an id from `restic snapshots`, or latest",
      });
    const { paths, env, host } = yield* session(["restic"]);
    const target = absolutePath(targetDir);
    yield* fs.makeDirectory(target, { recursive: true }).pipe(Effect.mapError(fsFailed));
    yield* must(restoreArgs(host, snapshot, target), env, { inherit: true });
    const stage = absolutePath(join(target, paths.stage));
    const entries = yield* entriesOf(target, stage);
    yield* place(target, stage, entries);
    yield* fs.remove(stage, { recursive: true, force: true }).pipe(Effect.mapError(fsFailed));
    const sources = yield* readSources.pipe(Effect.orElseSucceed(() => []));
    const roots = new Set([...entries, ...sources].map((item) => item.path));
    yield* out.success(
      `restored ${snapshot} into ${target} and put back ${plural(entries.length, "sqlite snapshot")}`,
    );
    yield* out.log("Stop the agents, then move what you need into place:");
    for (const root of roots)
      if (yield* fs.exists(join(target, root)).pipe(Effect.orElseSucceed(() => false)))
        yield* out.log(`  ${join(target, root)} -> ${root}`);
    yield* out.log("Delete any -wal or -shm file next to a database you replace.");
    yield* out.log(`Nothing outside ${target} was changed.`);
  });

export const listSources = Effect.gen(function* () {
  const out = yield* Output;
  yield* prepareConfig;
  for (const source of yield* loadSources) yield* out.stdout(`${source.name}\t${source.path}\n`);
});
