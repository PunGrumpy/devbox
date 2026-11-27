import { isAbsolute, resolve } from "node:path";

import { Schema } from "effect";

export const AbsolutePath = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (path: string) => isAbsolute(path) && resolve(path) === path
    )
  ),
  Schema.brand("AbsolutePath")
);
export type AbsolutePath = typeof AbsolutePath.Type;

export const absolutePath = (
  path: string,
  from = process.cwd()
): AbsolutePath => AbsolutePath.make(resolve(from, path));

// SQLite's LIKE ignores ASCII case, so the under-root match runs here instead of in SQL.
export const isUnderRoot = (path: string, root: AbsolutePath): boolean =>
  path === root || path.startsWith(root === "/" ? root : `${root}/`);

export const rebase = (
  path: string,
  from: AbsolutePath,
  to: AbsolutePath
): string => to + path.slice(from.length);

// Claude Code keeps a project in projects/<slug>: the resolved cwd with every non-alphanumeric character turned into '-'.
export const slugOf = (path: AbsolutePath): string =>
  path.replace(/[^A-Za-z0-9]/g, "-");
