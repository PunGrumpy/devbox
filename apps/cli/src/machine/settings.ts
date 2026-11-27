import path from "node:path";

import { Data } from "effect";

export type Setting = Data.TaggedEnum<{
  Git: { readonly key: string; readonly values: readonly string[] };
  Env: { readonly name: string; readonly value: string };
  Path: { readonly dirs: readonly string[] };
}>;

export const Setting = Data.taggedEnum<Setting>();

/** CLAUDE_CONFIG_DIR is under `data` because Claude Code moves .claude.json into it when it is set. */
export const settingsFor = (data: string) =>
  [
    Setting.Git({ key: "user.name", values: ["PunGrumpy"] }),
    Setting.Git({
      key: "user.email",
      values: ["108584943+PunGrumpy@users.noreply.github.com"],
    }),
    Setting.Git({ key: "commit.gpgsign", values: ["false"] }),
    Setting.Git({
      key: "credential.https://github.com.helper",
      values: ["", "!gh auth git-credential"],
    }),
    Setting.Env({
      name: "MISE_DATA_DIR",
      value: path.join(data, ".local", "share", "mise"),
    }),
    Setting.Env({ name: "RUSTUP_HOME", value: path.join(data, ".rustup") }),
    Setting.Env({ name: "CARGO_HOME", value: path.join(data, ".cargo") }),
    Setting.Env({
      name: "CLAUDE_CONFIG_DIR",
      value: path.join(data, ".claude"),
    }),
    Setting.Path({
      dirs: [
        path.join(data, ".local", "bin"),
        path.join(data, ".local", "share", "mise", "shims"),
      ],
    }),
  ] satisfies readonly Setting[];

export const gitEntries = (settings: readonly Setting[]) =>
  settings.flatMap((setting) => (setting._tag === "Git" ? [setting] : []));

export const processEnv = (
  settings: readonly Setting[],
  inheritedPath: string
) =>
  Object.fromEntries(
    settings.flatMap((setting) =>
      Setting.$match(setting, {
        Git: () => [],
        Env: ({ name, value }) => [[name, value] satisfies [string, string]],
        Path: ({ dirs }) => [
          [
            "PATH",
            [...dirs, inheritedPath].filter((part) => part !== "").join(":"),
          ] satisfies [string, string],
        ],
      })
    )
  );

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const profileLine = (setting: Setting) =>
  Setting.$match(setting, {
    Git: () => [],
    Env: ({ name, value }) => [`export ${name}=${shellQuote(value)}`],
    Path: ({ dirs }) => [
      `export PATH=${dirs.map(shellQuote).join(":")}:"$PATH"`,
    ],
  });

export const profileScript = (settings: readonly Setting[], user: string) => {
  const body = settings
    .flatMap(profileLine)
    .map((line) => `  ${line}\n`)
    .join("");

  return `if [ "$(id -un)" = ${shellQuote(user)} ]; then\n${body}fi\n`;
};
