import { Effect, FileSystem, Option } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Output, plural } from "../output.ts";
import { type ServeConfig, pathsOf } from "./config.ts";
import { Host } from "./host.ts";
import { processEnv, settingsFor } from "./settings.ts";
import { parseSkillsList, SKILLS_LIST_URL, skillsAddArgs } from "./skills.ts";

const BROWSER_PACKAGES = [
  "libnss3",
  "libglib2.0-0",
  "libatk1.0-0",
  "libatk-bridge2.0-0",
  "libatspi2.0-0",
  "libdbus-1-3",
  "libx11-6",
  "libxcb1",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxrandr2",
  "libxkbcommon0",
  "libgbm1",
  "libasound2",
  "libexpat1",
  "fontconfig",
  "fonts-liberation",
];

const browserLibraries = Effect.gen(function* () {
  const host = yield* Host;
  const out = yield* Output;
  if (!(yield* host.which("apt-get"))) return yield* out.log("browser: no apt-get, skipped");
  if ((yield* host.run(["dpkg", "-s", ...BROWSER_PACKAGES])).code === 0)
    return yield* out.log("browser: libraries present");
  const update = yield* host.run(["sudo", "-n", "apt-get", "update", "-qq"], { inherit: true });
  const install =
    update.code === 0
      ? yield* host.run(
          [
            "sudo",
            "-n",
            "env",
            "DEBIAN_FRONTEND=noninteractive",
            "apt-get",
            "install",
            "-y",
            "-qq",
            "--no-install-recommends",
            ...BROWSER_PACKAGES,
          ],
          { inherit: true },
        )
      : update;
  yield* install.code === 0
    ? out.log("browser: libraries installed")
    : out.warn("browser: could not install the libraries (needs passwordless sudo)");
});

const languages = (data: string, env: Record<string, string>) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const fs = yield* FileSystem.FileSystem;
    const out = yield* Output;
    const { mise } = pathsOf(data);
    if (!(yield* fs.exists(mise).pipe(Effect.orElseSucceed(() => false)))) {
      const installer = yield* host.run(["curl", "-fsSL", "https://mise.run"]);
      if (installer.code !== 0) return yield* out.warn("tools: cannot download mise");
      yield* host.run(["sh"], {
        stdin: installer.stdout,
        env: { ...env, MISE_INSTALL_PATH: mise },
        inherit: true,
      });
    }
    const use = yield* host.run([mise, "use", "--global", "--yes", "go@latest", "rust@latest"], {
      env,
      inherit: true,
    });
    yield* use.code === 0 ? out.log("tools: go and rust ready") : out.warn("tools: mise failed");
  });

export const installSkills = (data: string, env: Record<string, string>) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const fs = yield* FileSystem.FileSystem;
    const out = yield* Output;
    const fetched = yield* host.run(["curl", "-fsSL", SKILLS_LIST_URL]);
    if (fetched.code !== 0) return yield* out.warn("skills: cannot read the list");
    const list = parseSkillsList(fetched.stdout);
    const { skillsStamp } = pathsOf(data);
    const stamp = yield* fs.readFileString(skillsStamp).pipe(Effect.option);
    if (
      Option.contains(
        Option.map(stamp, (s) => s.trim()),
        list.hash,
      )
    )
      return yield* out.log("skills: up to date");
    for (const line of list.rejected)
      yield* out.warn(`skills: ignored a line that is not a skill source: ${line}`);
    const cwd = mkdtempSync(join(tmpdir(), "devbox-skills-"));
    const failed = yield* Effect.filter(list.sources, (source) =>
      Effect.map(host.run(skillsAddArgs(source), { env, cwd, inherit: true }), (r) => r.code !== 0),
    );
    yield* fs.remove(cwd, { recursive: true }).pipe(Effect.ignore);
    if (failed.length === 0 && list.rejected.length === 0) {
      yield* fs.writeFileString(skillsStamp, `${list.hash}\n`).pipe(Effect.ignore);
      return yield* out.log(`skills: installed ${plural(list.sources.length, "source")}`);
    }
    yield* out.warn(
      `skills: ${plural(failed.length + list.rejected.length, "source")} failed, trying again on the next start`,
    );
  });

export const postStart = (config: ServeConfig) =>
  Effect.gen(function* () {
    const out = yield* Output;
    const env = processEnv(settingsFor(config.data), process.env.PATH ?? "");
    yield* out.log("setup: starting");
    yield* browserLibraries;
    yield* languages(config.data, env);
    yield* installSkills(config.data, env);
    yield* out.log("setup: done");
  });
