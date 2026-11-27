import { randomBytes } from "node:crypto";
import { basename, dirname, join, relative, sep } from "node:path";

import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { formatBytes, Output, plural } from "../output.ts";
import { type ClaudeHome, ClaudeHomes } from "./claude-homes.ts";
import {
  type AbsolutePath,
  absolutePath,
  isUnderRoot,
  rebase,
  slugOf,
} from "./paths.ts";

export class ClaudeFilesError extends Schema.TaggedError<ClaudeFilesError>()(
  "ClaudeFilesError",
  {
    message: Schema.String,
    hint: Schema.String,
  }
) {}

const NOTHING_CHANGED = "nothing was changed; fix the problem named above";

const fail = (message: string, hint = NOTHING_CHANGED) =>
  new ClaudeFilesError({ message, hint });

export type RootMove = {
  readonly from: AbsolutePath;
  readonly to: AbsolutePath;
  readonly cwds: ReadonlyArray<string>;
};

type SlugMove = {
  readonly fromSlug: string;
  readonly toSlug: string;
  readonly isRoot: boolean;
};

type FileCopy = {
  readonly src: string;
  readonly dest: string;
  readonly base: string;
};

type SlugCopy = {
  readonly home: ClaudeHome;
  readonly move: SlugMove;
  readonly destDir: string;
  readonly files: ReadonlyArray<FileCopy>;
  readonly skipped: number;
};

type Scan = {
  readonly copies: ReadonlyArray<SlugCopy>;
  readonly linkedSlugs: ReadonlyArray<string>;
  readonly missingHomes: ReadonlyArray<ClaudeHome>;
  readonly rootSlugSeen: boolean;
};

export type CopyPlan = {
  readonly homes: ReadonlyArray<ClaudeHome>;
  readonly moves: ReadonlyArray<SlugMove>;
  readonly scan: Scan;
};

export type CopyResult = {
  readonly files: number;
  readonly bytes: number;
  readonly conflicts: ReadonlyArray<string>;
};

type Outcome = "copy" | "identical" | "conflict";

const TEMP_SUFFIX = ".devbox-migrate.tmp";

const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

const errnoOf = (error: PlatformError): string | undefined => {
  const cause = error.reason.cause;

  return cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string"
    ? cause.code
    : undefined;
};

const isNotFound = (error: PlatformError) => error.reason._tag === "NotFound";

const lstatIfExists = (fs: FileSystem.FileSystem, path: string) =>
  fs.lstat(path).pipe(
    Effect.map(Option.some),
    Effect.catchIf(isNotFound, () => Effect.succeedNone),
    Effect.mapError((error) => fail(`cannot inspect ${path}: ${error.message}`))
  );

const MAX_LINKS = 40;

export const resolvedPath = Effect.fn("resolvedPath")(function* (
  path: string,
  links = 0
): Effect.fn.Return<AbsolutePath, ClaudeFilesError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const tail: Array<string> = [];
  let head: string = absolutePath(path);

  for (;;) {
    const real = yield* fs.realPath(head).pipe(
      Effect.map(Option.some),
      Effect.catchIf(isNotFound, () => Effect.succeedNone),
      Effect.mapError((error) =>
        fail(`cannot resolve ${head}: ${error.message}`)
      )
    );

    if (Option.isSome(real)) {
      return absolutePath(join(real.value, ...tail));
    }
    const entry = yield* lstatIfExists(fs, head);

    if (Option.isSome(entry) && entry.value.type === "SymbolicLink") {
      if (links >= MAX_LINKS) {
        return yield* fail(`too many symbolic links at ${head}`);
      }
      const link = yield* fs
        .readLink(head)
        .pipe(
          Effect.mapError((error) =>
            fail(`cannot resolve ${head}: ${error.message}`)
          )
        );

      const parent = yield* resolvedPath(dirname(head), links + 1);

      return yield* resolvedPath(
        join(absolutePath(link, parent), ...tail),
        links + 1
      );
    }

    const parent = dirname(head);

    if (parent === head) {
      return absolutePath(path);
    }
    tail.unshift(basename(head));
    head = parent;
  }
});

const walk = (
  fs: FileSystem.FileSystem,
  dir: string,
  destDir: string,
  base: string
): Effect.Effect<
  { files: ReadonlyArray<FileCopy>; skipped: number },
  PlatformError
> =>
  Effect.gen(function* () {
    const files: Array<FileCopy> = [];
    let skipped = 0;

    for (const entry of yield* fs.readDirectoryEntries(dir)) {
      const src = join(dir, entry.name);
      const dest = join(destDir, entry.name);

      if (entry.type === "Directory") {
        const inner = yield* walk(fs, src, dest, base);
        files.push(...inner.files);
        skipped += inner.skipped;
      } else if (entry.name.endsWith(TEMP_SUFFIX)) {
        continue;
      } else if (entry.type === "File") {
        files.push({ src, dest, base });
      } else {
        skipped += 1;
      }
    }

    return { files, skipped };
  });

const pathIsBlocked = (fs: FileSystem.FileSystem, file: FileCopy) =>
  Effect.gen(function* () {
    let dir = file.base;

    for (const part of relative(file.base, dirname(file.dest)).split(sep)) {
      if (part === "") {
        continue;
      }
      dir = join(dir, part);
      const entry = yield* lstatIfExists(fs, dir);

      if (Option.isNone(entry)) {
        return false;
      }
      if (entry.value.type !== "Directory") {
        return true;
      }
    }

    return false;
  });

const classify = (fs: FileSystem.FileSystem, file: FileCopy) =>
  Effect.gen(function* () {
    const source = yield* fs.lstat(file.src);

    if (source.type !== "File") {
      return yield* fail(`${file.src} is no longer a regular file`);
    }
    const size = Number(source.size);
    const result = (outcome: Outcome) => ({ outcome, size });

    if (yield* pathIsBlocked(fs, file)) {
      return result("conflict");
    }
    const existing = yield* lstatIfExists(fs, file.dest);

    if (Option.isNone(existing)) {
      return result("copy");
    }
    if (
      existing.value.type !== "File" ||
      Number(existing.value.size) !== size
    ) {
      return result("conflict");
    }
    const [a, b] = yield* Effect.all([
      fs.readFile(file.src),
      fs.readFile(file.dest),
    ]);

    return result(
      Buffer.from(a).equals(Buffer.from(b)) ? "identical" : "conflict"
    );
  });

// link(2) fails with EEXIST where rename(2) replaces, and Node has no atomic no-clobber copy; the rename fallback leaves a race window.
const placeWithoutClobber = (fs: FileSystem.FileSystem, file: FileCopy) =>
  Effect.gen(function* () {
    const source = yield* fs.lstat(file.src);
    yield* fs.makeDirectory(dirname(file.dest), { recursive: true });

    const temp = join(
      dirname(file.dest),
      `.${randomBytes(8).toString("hex")}${TEMP_SUFFIX}`
    );

    return yield* Effect.gen(function* () {
      yield* fs.copyFile(file.src, temp);
      yield* fs.utimes(
        temp,
        Option.getOrElse(source.atime, () => new Date()),
        Option.getOrElse(source.mtime, () => new Date())
      );

      return yield* fs.link(temp, file.dest).pipe(
        Effect.as("placed" as const),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed("exists" as const)
        ),
        Effect.catchIf(
          (error) => NO_HARD_LINKS.has(errnoOf(error) ?? ""),
          () =>
            Effect.gen(function* () {
              if (Option.isSome(yield* lstatIfExists(fs, file.dest))) {
                return "exists" as const;
              }
              yield* fs.rename(temp, file.dest);

              return "placed" as const;
            })
        )
      );
    }).pipe(
      Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore))
    );
  });

const slugMoves = Effect.fn("slugMoves")(function* (move: RootMove) {
  const moves = new Map<string, SlugMove>();

  for (const cwd of [move.from, ...move.cwds]) {
    const fromSlug = slugOf(yield* resolvedPath(cwd));
    const toSlug = slugOf(yield* resolvedPath(rebase(cwd, move.from, move.to)));

    if (fromSlug === toSlug) {
      continue;
    }
    const key = `${fromSlug} ${toSlug}`;
    moves.set(key, {
      fromSlug,
      toSlug,
      isRoot: cwd === move.from || moves.get(key)?.isRoot === true,
    });
  }

  return [...moves.values()];
});

const scan = (
  homes: ReadonlyArray<ClaudeHome>,
  moves: ReadonlyArray<SlugMove>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const exists = (path: string) =>
      fs.exists(path).pipe(Effect.orElseSucceed(() => false));

    const realOrSelf = (path: string) =>
      fs.realPath(path).pipe(Effect.orElseSucceed(() => path));

    const copies: Array<SlugCopy> = [];
    const linkedSlugs: Array<string> = [];

    const missingHomes = yield* Effect.filter(homes, (home) =>
      Effect.map(exists(home.path), (found) => home.enabled && !found)
    );

    let rootSlugSeen = false;

    for (const home of homes) {
      const base = join(home.path, "projects");

      for (const move of moves) {
        const srcDir = join(base, move.fromSlug);
        const destDir = join(base, move.toSlug);
        const entry = yield* lstatIfExists(fs, srcDir);

        if (Option.isNone(entry)) {
          continue;
        }
        if (entry.value.type === "SymbolicLink") {
          linkedSlugs.push(srcDir);
          rootSlugSeen ||= move.isRoot;
          continue;
        }

        if (entry.value.type !== "Directory") {
          continue;
        }
        rootSlugSeen ||= move.isRoot;

        if (
          (yield* exists(destDir)) &&
          (yield* realOrSelf(destDir)) === (yield* realOrSelf(srcDir))
        ) {
          continue;
        }
        const { files, skipped } = yield* walk(fs, srcDir, destDir, base).pipe(
          Effect.mapError((error) =>
            fail(`cannot read ${srcDir}: ${error.message}`)
          )
        );

        copies.push({ home, move, destDir, files, skipped });
      }
    }

    return { copies, linkedSlugs, missingHomes, rootSlugSeen } satisfies Scan;
  });

const tally = (fs: FileSystem.FileSystem, files: ReadonlyArray<FileCopy>) =>
  Effect.gen(function* () {
    const count = { copy: 0, identical: 0, conflict: 0, bytes: 0 };
    const conflicts: Array<string> = [];

    for (const file of files) {
      const { outcome, size } = yield* classify(fs, file);
      count[outcome] += 1;

      if (outcome === "copy") {
        count.bytes += size;
      }
      if (outcome === "conflict") {
        conflicts.push(file.dest);
      }
    }

    return { ...count, conflicts };
  });

const warnMissingHomes = (
  out: Output["Service"],
  homes: ReadonlyArray<ClaudeHome>
) =>
  Effect.forEach(
    homes,
    (home) =>
      out.warn(
        `Claude home ${home.path} (${home.instances.join(", ")}) does not exist here, so nothing was copied from it`
      ),
    { discard: true }
  );

const asClaudeFilesError =
  (message: string, hint: string) => (error: unknown) =>
    error instanceof ClaudeFilesError
      ? error
      : fail(
          `${message}: ${error instanceof Error ? error.message : String(error)}`,
          hint
        );

export class ClaudeFiles extends Context.Service<
  ClaudeFiles,
  {
    readonly plan: (
      move: RootMove
    ) => Effect.Effect<CopyPlan, ClaudeFilesError>;
    readonly show: (plan: CopyPlan) => Effect.Effect<void, ClaudeFilesError>;
    readonly apply: (
      plan: CopyPlan
    ) => Effect.Effect<CopyResult, ClaudeFilesError>;
  }
>()("devbox/migrate/ClaudeFiles") {
  static readonly layer = Layer.effect(
    ClaudeFiles,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const out = yield* Output;
      const claudeHomes = yield* ClaudeHomes;
      const provide = Effect.provideService(FileSystem.FileSystem, fs);

      const plan = (move: RootMove) =>
        Effect.gen(function* () {
          const homes = yield* claudeHomes.list.pipe(
            Effect.mapError((error) => fail(error.message, error.hint))
          );

          const moves = yield* slugMoves(move);

          return { homes, moves, scan: yield* scan(homes, moves) };
        }).pipe(provide);

      const show = (copyPlan: CopyPlan) =>
        Effect.gen(function* () {
          yield* out.line();
          yield* out.log(
            "Claude transcripts and memory (copied, never moved or deleted)"
          );

          if (copyPlan.moves.length === 0) {
            return yield* out.log(
              out.paint(
                "dim",
                "the root keeps the same Claude slug, nothing to copy"
              )
            );
          }

          if (copyPlan.homes.length === 0) {
            return yield* out.warn(
              "no Claude provider instance in settings.json, so no Claude files were looked for"
            );
          }

          yield* warnMissingHomes(out, copyPlan.scan.missingHomes);

          for (const path of copyPlan.scan.linkedSlugs) {
            yield* out.warn(`${path} is a symlink, so it is not copied`);
          }
          const root = copyPlan.moves.find((move) => move.isRoot);

          if (root && !copyPlan.scan.rootSlugSeen) {
            yield* out.warn(
              `no Claude home has projects/${root.fromSlug}; the slug format may have changed`
            );
          }

          let shown: ClaudeHome | undefined;

          for (const copy of copyPlan.scan.copies) {
            if (copy.home !== shown) {
              yield* out.line(
                `  ${out.paint("dim", copy.home.instances.join(", "))}  ${copy.home.path}`
              );
              shown = copy.home;
            }

            const t = yield* tally(fs, copy.files);
            yield* out.line(
              `    ${copy.move.fromSlug} ${out.paint("dim", "->")} ${copy.destDir}`
            );
            yield* out.line(
              `      ${plural(t.copy, "file")} to copy (${formatBytes(t.bytes)}), ${t.identical} already there, ${plural(t.conflict, "conflict")}, ${plural(copy.skipped, "symlink or special file")} skipped`
            );

            for (const path of t.conflicts) {
              yield* out.line(`      ${out.paint("dim", "differs:")} ${path}`);
            }
          }
        }).pipe(
          Effect.mapError(
            asClaudeFilesError("cannot compare Claude files", NOTHING_CHANGED)
          )
        );

      const apply = (copyPlan: CopyPlan) =>
        Effect.gen(function* () {
          const now = yield* scan(copyPlan.homes, copyPlan.moves).pipe(provide);
          yield* warnMissingHomes(
            out,
            now.missingHomes.filter(
              (home) => !copyPlan.scan.missingHomes.includes(home)
            )
          );
          const conflicts = new Set<string>();
          const arrived = new Map<string, number>();
          let files = 0;
          let bytes = 0;

          if (now.copies.length === 0) {
            return { files, bytes, conflicts: [] };
          }
          yield* Effect.gen(function* () {
            for (const copy of now.copies) {
              for (const file of copy.files) {
                const { outcome, size } = yield* classify(fs, file);

                if (outcome === "identical") {
                  arrived.set(file.dest, size);
                }
                if (outcome === "conflict") {
                  conflicts.add(file.dest);
                }
                if (outcome !== "copy") {
                  continue;
                }
                if ((yield* placeWithoutClobber(fs, file)) === "exists") {
                  conflicts.add(file.dest);
                  continue;
                }

                arrived.set(file.dest, size);
                files += 1;
                bytes += size;
              }
            }
          }).pipe(
            Effect.mapError(
              asClaudeFilesError(
                "copying Claude files failed",
                "the database was not touched; the copy is additive, so run it again"
              )
            )
          );

          const missing = yield* Effect.filter(
            now.copies
              .flatMap((copy) => copy.files)
              .filter((file) => !conflicts.has(file.dest)),
            (file) =>
              fs.stat(file.dest).pipe(
                Effect.map(
                  (info) =>
                    info.type !== "File" ||
                    Number(info.size) < (arrived.get(file.dest) ?? 0)
                ),
                Effect.orElseSucceed(() => true)
              )
          );

          if (missing.length > 0) {
            return yield* fail(
              `${plural(missing.length, "Claude file")} missing after the copy: ${missing[0]?.dest}`,
              "the database was not touched; delete the incomplete file at the destination, then run it again"
            );
          }

          yield* out.log(
            `copied ${plural(files, "Claude file")} (${formatBytes(bytes)}), ${plural(conflicts.size, "conflict")}`
          );

          return { files, bytes, conflicts: [...conflicts] };
        });

      return { plan, show, apply };
    })
  );

  static readonly layerRehearsal = Layer.effect(
    ClaudeFiles,
    Effect.gen(function* () {
      const out = yield* Output;

      const empty: CopyPlan = {
        homes: [],
        moves: [],
        scan: {
          copies: [],
          linkedSlugs: [],
          missingHomes: [],
          rootSlugSeen: false,
        },
      };

      return {
        plan: () => Effect.succeed(empty),
        show: () =>
          out.note(
            "--db points at a copy, so Claude transcripts and memory are not copied"
          ),
        apply: () => Effect.succeed({ files: 0, bytes: 0, conflicts: [] }),
      };
    })
  );
}

export const reportConflicts = (result: CopyResult) =>
  Effect.gen(function* () {
    if (result.conflicts.length === 0) {
      return;
    }
    const out = yield* Output;
    yield* out.warn(
      `${plural(result.conflicts.length, "file")} already existed with other content, or sat behind a symlink, and were left as they are:`
    );

    for (const path of result.conflicts) {
      yield* out.line(`  ${path}`);
    }
  });

export type StrandedMemory = {
  readonly project: string;
  readonly projectId: string;
  readonly home: string;
  readonly cwd: string;
  readonly unresolvedSlug: string;
  readonly liveSlug: string;
  readonly files: number;
  readonly missing: number;
  readonly liveFiles: number;
};

export const strandedMemory = Effect.fn("strandedMemory")(function* (
  projects: ReadonlyArray<{
    readonly projectId: string;
    readonly title: string;
    readonly workspaceRoot: string;
  }>,
  cwds: ReadonlyArray<string>
) {
  const fs = yield* FileSystem.FileSystem;
  const homes = yield* (yield* ClaudeHomes).list;

  const memoryNames = (home: string, slug: string) =>
    fs.readDirectoryEntries(join(home, "projects", slug, "memory")).pipe(
      Effect.map((entries) =>
        entries
          .filter(
            (entry) => entry.type === "File" && entry.name.endsWith(".md")
          )
          .map((entry) => entry.name)
      ),
      Effect.orElseSucceed((): ReadonlyArray<string> => [])
    );

  const found = new Map<string, StrandedMemory>();

  for (const project of projects) {
    const root = absolutePath(project.workspaceRoot);

    const paths = new Set(
      [root, ...cwds.filter((cwd) => isUnderRoot(cwd, root))].map((path) =>
        absolutePath(path)
      )
    );

    for (const cwd of paths) {
      const unresolvedSlug = slugOf(cwd);
      const liveSlug = slugOf(yield* resolvedPath(cwd));

      if (unresolvedSlug === liveSlug) {
        continue;
      }
      for (const home of homes) {
        const key = `${home.path} ${unresolvedSlug}`;
        const names = yield* memoryNames(home.path, unresolvedSlug);

        if (names.length === 0 || found.has(key)) {
          continue;
        }
        const live = new Set(yield* memoryNames(home.path, liveSlug));
        found.set(key, {
          project: project.title,
          projectId: project.projectId,
          home: home.path,
          cwd,
          unresolvedSlug,
          liveSlug,
          files: names.length,
          missing: names.filter((name) => !live.has(name)).length,
          liveFiles: live.size,
        });
      }
    }
  }

  return [...found.values()];
});
