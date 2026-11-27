import path from "node:path";

export type Excluded = (path: string) => boolean;

/** Restic expands `$NAME` and `${NAME}` in exclude files, and `$$` is a literal `$`. */
export const expandVars = (
  line: string,
  vars: Readonly<Record<string, string | undefined>>
) =>
  line.replaceAll(
    /\$(?:(?<dollar>\$)|\{(?<braced>[^}]*)\}|(?<bare>[A-Za-z_]\w*))/gu,
    (_, dollar?: string, braced?: string, bare?: string) => {
      if (dollar !== undefined) {
        return "$";
      }

      const name = braced ?? bare ?? "";

      return vars[name] ?? "";
    }
  );

const withoutTrailingSlashes = (line: string) => {
  let end = line.length;

  while (end > 0 && line.endsWith("/", end)) {
    end -= 1;
  }

  return line.slice(0, end);
};

export const excludedBy = (
  text: string,
  vars: Readonly<Record<string, string | undefined>>
) => {
  const patterns = text
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => line !== "" && !line.startsWith("#") && !line.startsWith("!")
    )
    .map((line) => withoutTrailingSlashes(expandVars(line, vars)))
    .filter((line) => line !== "");

  const names = patterns
    .filter((p) => !p.includes("/"))
    .map((p) => new Bun.Glob(p));

  const paths = patterns
    .filter((p) => p.includes("/"))
    .map((p) => new Bun.Glob(p.startsWith("/") ? p : `**/${p}`));

  return ((file) => {
    const name = path.basename(file);

    return (
      names.some((glob) => glob.match(name)) ||
      paths.some((glob) => glob.match(file))
    );
  }) satisfies Excluded;
};
