import path from "node:path";

import { Schema } from "effect";

export const AbsolutePath = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: string) => path.isAbsolute(value) && path.resolve(value) === value
    )
  ),
  Schema.brand("AbsolutePath")
);

export type AbsolutePath = typeof AbsolutePath.Type;

export const absolutePath = (target: string, from = process.cwd()) =>
  AbsolutePath.make(path.resolve(from, target));

/** Whether `candidate` is `root` or inside it. SQLite's LIKE ignores ASCII case, so this match runs here instead of in SQL. */
export const isUnderRoot = (candidate: string, root: AbsolutePath) =>
  candidate === root || candidate.startsWith(root === "/" ? root : `${root}/`);

export const rebase = (file: string, from: AbsolutePath, to: AbsolutePath) =>
  to + file.slice(from.length);

/**
 * The folder name Claude Code gives a project in `projects/<slug>`: the resolved cwd with every
 * non-alphanumeric UTF-16 code unit turned into `-`.
 */
export const slugOf = (cwd: AbsolutePath) =>
  cwd.replaceAll(/[^A-Za-z0-9]/gu, (char) => "-".repeat(char.length));
