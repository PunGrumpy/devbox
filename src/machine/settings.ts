import { Data } from "effect";
import { join } from "node:path";

export type Setting = Data.TaggedEnum<{
  Git: { readonly key: string; readonly values: ReadonlyArray<string> };
  Env: { readonly name: string; readonly value: string };
  Path: { readonly dirs: ReadonlyArray<string> };
}>;
export const Setting = Data.taggedEnum<Setting>();

export const settingsFor = (data: string): ReadonlyArray<Setting> => [
  Setting.Git({ key: "user.name", values: ["PunGrumpy"] }),
  Setting.Git({ key: "user.email", values: ["108584943+PunGrumpy@users.noreply.github.com"] }),
  Setting.Git({ key: "commit.gpgsign", values: ["false"] }),
  Setting.Git({
    key: "credential.https://github.com.helper",
    values: ["", "!gh auth git-credential"],
  }),
  Setting.Env({ name: "MISE_DATA_DIR", value: join(data, ".local", "share", "mise") }),
  Setting.Env({ name: "RUSTUP_HOME", value: join(data, ".rustup") }),
  Setting.Env({ name: "CARGO_HOME", value: join(data, ".cargo") }),
  // Claude Code moves .claude.json into $CLAUDE_CONFIG_DIR when it is set.
  Setting.Env({ name: "CLAUDE_CONFIG_DIR", value: join(data, ".claude") }),
  Setting.Path({
    dirs: [join(data, ".local", "bin"), join(data, ".local", "share", "mise", "shims")],
  }),
];

export const gitEntries = (settings: ReadonlyArray<Setting>) =>
  settings.flatMap((setting) => (setting._tag === "Git" ? [setting] : []));

export const processEnv = (
  settings: ReadonlyArray<Setting>,
  path: string,
): Record<string, string> =>
  Object.fromEntries(
    settings.flatMap((setting) => {
      switch (setting._tag) {
        case "Git":
          return [];
        case "Env":
          return [[setting.name, setting.value]];
        case "Path":
          return [["PATH", [...setting.dirs, path].filter((part) => part !== "").join(":")]];
      }
    }),
  );

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export const profileScript = (settings: ReadonlyArray<Setting>): string =>
  settings
    .flatMap((setting) => {
      switch (setting._tag) {
        case "Git":
          return [];
        case "Env":
          return [`export ${setting.name}=${shellQuote(setting.value)}`];
        case "Path":
          return [`export PATH=${setting.dirs.map(shellQuote).join(":")}:"$PATH"`];
      }
    })
    .map((line) => `${line}\n`)
    .join("");
