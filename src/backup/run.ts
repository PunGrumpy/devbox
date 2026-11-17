import { Effect, FileSystem, Option, Schema } from "effect";
import { closeSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { Host, TIMED_OUT } from "../machine/host.ts";
import { Locations } from "../migrate/locations.ts";
import { AbsolutePath } from "../migrate/paths.ts";
import { Output, plural } from "../output.ts";
import { backupPaths, ensureConfig, parseEnv } from "./config.ts";
import {
  type BackupPlan,
  backupArgs,
  entryFor,
  excludeFile,
  forgetArgs,
  hasSqliteHeader,
  parseSources,
  quickCheckArgs,
  sidecars,
  BACKUP_TIMEOUT_MS,
  vacuumIntoArgs,
  restoreArgs,
  type Source,
  type SqliteSnapshot,
  sqliteBackupArgs,
  SQLITE_HEADER,
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
      entry.type === "File"
        ? Effect.succeed([join(dir, entry.name)])
        : entry.type === "Directory"
          ? walk(join(dir, entry.name))
          : Effect.succeed([]),
    );
    return nested.flat();
  });

const tools = Effect.gen(function* () {
  const host = yield* Host;
  const missing = yield* Effect.filter(["restic", "sqlite3"], (name) =>
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

const session = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
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
  yield* tools;
  yield* fs.makeDirectory(paths.state, { recursive: true }).pipe(Effect.mapError(fsFailed));
  return { home, paths, env: values };
});

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
              const holder = Number(
                (yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""))).trim(),
              );
              const running = (yield* host.processes).some((proc) => proc.pid === holder);
              if (running)
                return yield* new BackupFailed({
                  message: `another devbox backup is running (pid ${holder})`,
                });
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

export const loadSources = Effect.gen(function* () {
  const { home } = yield* Locations;
  const fs = yield* FileSystem.FileSystem;
  const paths = backupPaths(home);
  const text = yield* fs.readFileString(paths.sources).pipe(Effect.mapError(fsFailed));
  const { sources, issues } = parseSources(text, home);
  if (issues.length > 0)
    return yield* new BackupFailed({
      message: `${paths.sources} has ${plural(issues.length, "line")} that cannot be read`,
      hint: issues.map((issue) => `line ${issue.line}: ${issue.why}`).join("\n"),
    });
  return yield* resolveSources(sources);
});

const discover = (stage: AbsolutePath, sources: ReadonlyArray<Source>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const snapshots: Array<SqliteSnapshot> = [];
    for (const source of sources) {
      const info = yield* fs.stat(source.path).pipe(Effect.mapError(fsFailed));
      const files = info.type === "Directory" ? yield* walk(source.path) : [source.path];
      for (const live of files)
        if (yield* isSqlite(live))
          snapshots.push({ source: source.name, live, entry: entryFor(source, live) });
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
        taken = yield* host.run(vacuumIntoArgs(snapshot.live, dest), { env });
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
  const { paths, env } = yield* session;
  yield* withLock(
    paths.lock,
    Effect.gen(function* () {
      const sources = yield* loadSources;
      if (sources.length === 0)
        return yield* new BackupFailed({ message: `no source in ${paths.sources} exists` });
      const plan = yield* discover(paths.stage, sources);
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
      yield* must(forgetArgs, env, { inherit: true });
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
  const { paths, env } = yield* session;
  yield* withLock(
    paths.lock,
    Effect.gen(function* () {
      yield* must(["restic", "check"], env, { inherit: true });
      const target = yield* fs
        .makeTempDirectory({ directory: paths.state, prefix: "verify-" })
        .pipe(Effect.mapError(fsFailed));
      yield* Effect.gen(function* () {
        yield* must(restoreArgs(paths, target), env, { inherit: true });
        const restored = yield* walk(target);
        if (restored.length === 0)
          return yield* new BackupFailed({
            message: `the latest snapshot holds no sqlite snapshot under ${paths.stage}`,
          });
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

export const listSources = Effect.gen(function* () {
  const out = yield* Output;
  yield* prepareConfig;
  for (const source of yield* loadSources) yield* out.stdout(`${source.name}\t${source.path}\n`);
});
