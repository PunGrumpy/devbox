import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, FileSystem, Option } from "effect";

import { Output, plural } from "../output.ts";
import { currentAgents, skillsAgentsOf, updateAgents } from "./agents.ts";
import { pathsOf } from "./config.ts";
import type { ServeConfig } from "./config.ts";
import { Host } from "./host.ts";
import {
  claudeHomes,
  INSTRUCTIONS_FILE,
  InstructionsLink,
  instructionsLink,
} from "./instructions.ts";
import { t3SettingsPath } from "./plan.ts";
import { processEnv, settingsFor } from "./settings.ts";
import { setupShell } from "./shell.ts";
import {
  parseSkillsList,
  SKILLS_LIST_URL,
  skillsAddArgs,
  skillsStamp,
} from "./skills.ts";

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

export const browserLibraries = Effect.gen(function* () {
  const host = yield* Host;
  const out = yield* Output;

  if (!(yield* host.which("apt-get"))) {
    return yield* out.log("browser: no apt-get, skipped");
  }

  const packages = yield* Effect.forEach(BROWSER_PACKAGES, (name) =>
    Effect.map(host.run(["apt-cache", "policy", `${name}t64`]), (policy) =>
      /Candidate: (?!\(none\))/u.test(policy.stdout) ? `${name}t64` : name
    )
  );

  if ((yield* host.run(["dpkg", "-s", ...packages])).code === 0) {
    return yield* out.log("browser: libraries present");
  }

  const update = yield* host.run(["sudo", "-n", "apt-get", "update", "-qq"], {
    inherit: true,
  });

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
            ...packages,
          ],
          { inherit: true }
        )
      : update;

  yield* install.code === 0
    ? out.log("browser: libraries installed")
    : out.warn(
        `browser: apt-get failed with exit ${install.code}; T3's browser preview may not start`
      );
});

export const ensureMise = (data: string, env: Record<string, string>) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const fs = yield* FileSystem.FileSystem;
    const { mise } = pathsOf(data);

    if (yield* fs.exists(mise).pipe(Effect.orElseSucceed(() => false))) {
      return true;
    }

    const installer = yield* host.run(["curl", "-fsSL", "https://mise.run"]);

    if (installer.code !== 0) {
      return false;
    }

    const ran = yield* host.run(["sh"], {
      stdin: installer.stdout,
      env: { ...env, MISE_INSTALL_PATH: mise },
      inherit: true,
    });

    return ran.code === 0;
  });

const languages = (data: string, env: Record<string, string>) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const out = yield* Output;
    const { mise } = pathsOf(data);

    if (!(yield* ensureMise(data, env))) {
      return yield* out.warn("tools: cannot download mise");
    }

    const gh = (yield* host.which("gh")) ? [] : ["gh@latest"];

    const use = yield* host.run(
      [
        mise,
        "use",
        "--global",
        "--yes",
        "go@latest",
        "rust@latest",
        "starship@latest",
        ...gh,
      ],
      { env, inherit: true }
    );

    yield* use.code === 0
      ? out.log("tools: go, rust and starship ready")
      : out.warn("tools: mise failed");
  });

export const installSkills = (
  data: string,
  env: Record<string, string>,
  agents: readonly string[]
) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const fs = yield* FileSystem.FileSystem;
    const out = yield* Output;

    if (agents.length === 0) {
      return yield* out.log("skills: no chosen agent takes skills");
    }

    const fetched = yield* host.run(["curl", "-fsSL", SKILLS_LIST_URL]);

    if (fetched.code !== 0) {
      return yield* out.warn("skills: cannot read the list");
    }

    const list = parseSkillsList(fetched.stdout);
    const paths = pathsOf(data);

    const stamp = yield* fs
      .readFileString(paths.skillsStamp)
      .pipe(Effect.option);

    const wanted = skillsStamp(list, agents);

    if (
      Option.contains(
        Option.map(stamp, (s) => s.trim()),
        wanted
      )
    ) {
      return yield* out.log("skills: up to date");
    }

    for (const line of list.rejected) {
      yield* out.warn(
        `skills: ignored a line that is not a skill source: ${line}`
      );
    }

    const cwd = mkdtempSync(path.join(tmpdir(), "devbox-skills-"));

    const failed = yield* Effect.filter(list.sources, (source) =>
      Effect.map(
        host.run(skillsAddArgs(source, agents), { env, cwd, inherit: true }),
        (r) => r.code !== 0
      )
    );

    yield* fs.remove(cwd, { recursive: true }).pipe(Effect.ignore);

    if (failed.length === 0 && list.rejected.length === 0) {
      yield* fs
        .writeFileString(paths.skillsStamp, `${wanted}\n`)
        .pipe(Effect.ignore);

      return yield* out.log(
        `skills: installed ${plural(list.sources.length, "source")}`
      );
    }

    yield* out.warn(
      `skills: ${plural(failed.length + list.rejected.length, "source")} failed, trying again on the next start`
    );
  });

export const linkInstructions = (
  config: Pick<ServeConfig, "data" | "baseDir">,
  home: string,
  sourcePath: string
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const out = yield* Output;
    const text = yield* fs.readFileString(sourcePath).pipe(Effect.option);

    if (Option.isNone(text)) {
      return yield* out.warn(`instructions: no ${sourcePath}`);
    }

    const source = { path: sourcePath, text: text.value };

    const settings = yield* fs
      .readFileString(t3SettingsPath(config.baseDir))
      .pipe(Effect.option);

    const linked = yield* Effect.filter(
      claudeHomes(settings, home, config.data),
      (dir) =>
        Effect.gen(function* () {
          const linkPath = path.join(dir, "CLAUDE.md");

          const now = {
            target: yield* fs.readLink(linkPath).pipe(Effect.option),
            text: yield* fs.readFileString(linkPath).pipe(Effect.option),
          };

          return yield* InstructionsLink.$match(instructionsLink(now, source), {
            Linked: () => Effect.succeed(false),
            NotOurs: () =>
              out
                .warn(
                  `instructions: left ${linkPath} alone, it is not a copy of ${sourcePath}`
                )
                .pipe(Effect.as(false)),
            Link: () =>
              fs.makeDirectory(dir, { recursive: true }).pipe(
                Effect.andThen(fs.remove(linkPath, { force: true })),
                Effect.andThen(fs.symlink(sourcePath, linkPath)),
                Effect.as(true),
                Effect.orElseSucceed(() => false)
              ),
          });
        })
    );

    yield* out.log(
      linked.length === 0
        ? "instructions: up to date"
        : `instructions: linked CLAUDE.md in ${linked.join(", ")}`
    );
  });

export const postStart = (config: ServeConfig, home: string) =>
  Effect.gen(function* () {
    const out = yield* Output;
    const env = processEnv(settingsFor(config.data), process.env.PATH ?? "");
    yield* out.log("setup: starting");
    yield* browserLibraries;
    yield* languages(config.data, env);
    yield* setupShell(home);
    const ids = yield* currentAgents(config.data);
    const host = yield* Host;
    yield* updateAgents(
      config.data,
      ids,
      (yield* host.which("npm")) ? "npm" : pathsOf(config.data).npmShim
    );
    yield* installSkills(config.data, env, skillsAgentsOf(ids));

    if (ids.includes("claude")) {
      yield* linkInstructions(config, home, INSTRUCTIONS_FILE);
    }

    yield* out.log("setup: done");
  });
