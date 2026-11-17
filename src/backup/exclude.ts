import { basename } from "node:path";

export type Excluded = (path: string) => boolean;

// restic expands $NAME and ${NAME} in exclude files, and $$ is a literal $.
export const expandVars = (line: string, vars: Readonly<Record<string, string | undefined>>) =>
  line.replace(
    /\$(?:(\$)|\{([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_, dollar?: string, braced?: string, bare?: string) =>
      dollar === undefined ? (vars[braced ?? bare ?? ""] ?? "") : "$",
  );

export const excludedBy = (
  text: string,
  vars: Readonly<Record<string, string | undefined>>,
): Excluded => {
  const patterns = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"))
    .map((line) => expandVars(line, vars).replace(/\/+$/, ""))
    .filter((line) => line !== "");
  const names = patterns.filter((p) => !p.includes("/")).map((p) => new Bun.Glob(p));
  const paths = patterns
    .filter((p) => p.includes("/"))
    .map((p) => new Bun.Glob(p.startsWith("/") ? p : `**/${p}`));
  return (path) => {
    const name = basename(path);
    return names.some((glob) => glob.match(name)) || paths.some((glob) => glob.match(path));
  };
};
