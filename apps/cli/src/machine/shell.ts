import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, FileSystem, Option } from "effect";

import { Output } from "../output.ts";
import { Host } from "./host.ts";
import { instructionsLink } from "./instructions.ts";

const ZSH = "/usr/bin/zsh";
export const SHELL_DIR = fileURLToPath(new URL("../../shell", import.meta.url));

const FILES = [
  { source: "zprofile", target: ".zprofile" },
  { source: "zshrc", target: ".zshrc" },
  { source: "starship.toml", target: join(".config", "starship.toml") },
] as const;

const linkFiles = (home: string, dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const out = yield* Output;

    for (const file of FILES) {
      const path = join(home, file.target);
      const sourcePath = join(dir, file.source);
      const text = yield* fs.readFileString(sourcePath).pipe(Effect.option);

      if (Option.isNone(text)) {
        yield* out.warn(`shell: no ${sourcePath}`);
        continue;
      }

      const now = {
        target: yield* fs.readLink(path).pipe(Effect.option),
        text: yield* fs.readFileString(path).pipe(Effect.option),
      };

      const link = instructionsLink(now, {
        path: sourcePath,
        text: text.value,
      });

      if (link._tag === "NotOurs") {
        yield* out.warn(`shell: left ${path} alone, it is not ours`);
      }
      if (link._tag !== "Link") {
        continue;
      }
      const linked = yield* fs
        .makeDirectory(dirname(path), { recursive: true })
        .pipe(
          Effect.andThen(fs.remove(path, { force: true })),
          Effect.andThen(fs.symlink(sourcePath, path)),
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        );

      yield* linked
        ? out.log(`shell: linked ${path}`)
        : out.warn(`shell: cannot link ${path}`);
    }
  });

const installZsh = Effect.gen(function* () {
  const host = yield* Host;
  const out = yield* Output;

  if (yield* host.which("zsh")) {
    return true;
  }
  const apt = [
    "apt-get",
    "install",
    "-y",
    "-qq",
    "--no-install-recommends",
    "zsh",
  ];

  const updated = yield* host.run(["sudo", "-n", "apt-get", "update", "-qq"], {
    inherit: true,
  });

  const installed =
    updated.code === 0 &&
    (yield* host.run(
      ["sudo", "-n", "env", "DEBIAN_FRONTEND=noninteractive", ...apt],
      {
        inherit: true,
      }
    )).code === 0;

  if (!installed) {
    yield* out.warn(
      "shell: no zsh, an admin can run: sudo apt-get install -y zsh"
    );
  }
  return installed;
});

const loginShell = Effect.gen(function* () {
  const host = yield* Host;
  const out = yield* Output;
  const entry = yield* host.run(["getent", "passwd", host.user]);

  if (entry.code !== 0) {
    return yield* out.warn(`shell: no passwd entry for ${host.user}`);
  }
  if (entry.stdout.trim().split(":").at(-1) === ZSH) {
    return yield* out.log("shell: zsh ready");
  }
  const changed = yield* host.run(["sudo", "-n", "chsh", "-s", ZSH, host.user]);
  yield* changed.code === 0
    ? out.log("shell: login shell is now zsh")
    : out.warn(`shell: an admin can run: sudo chsh -s ${ZSH} ${host.user}`);
});

// The files come first, so zsh never starts without the PATH that zprofile sets.
export const setupShell = (home: string, dir: string = SHELL_DIR) =>
  Effect.gen(function* () {
    yield* linkFiles(home, dir);

    if (yield* installZsh) {
      yield* loginShell;
    }
  });
