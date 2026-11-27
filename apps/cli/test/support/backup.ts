import { Database } from "bun:sqlite";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Ran } from "../../src/machine/host.ts";
import type { FakeMachine } from "./host.ts";

const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });

export const makeSqlite = (path: string, rows: number, wal = false) => {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);

  if (wal) {
    db.run("pragma journal_mode = wal");
  }
  db.run("create table if not exists t (n integer)");

  for (let i = 0; i < rows; i += 1) {
    db.run("insert into t values (?)", [i]);
  }
  db.close();
};

export const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

export const sourcesFile = (home: string, text: string) =>
  write(join(home, ".config/devbox/backup/sources"), text);

export const envFile = (home: string, text: string) =>
  write(join(home, ".config/devbox/backup/env"), text);

export type FakeRepo = { exists: boolean; failCheck: boolean; stage?: string };

export const withBackupTools = (
  m: FakeMachine,
  repo: FakeRepo = { exists: false, failCheck: false }
) => {
  m.binaries.add("restic");
  m.binaries.add("sqlite3");
  m.respond = (argv) => {
    const [cmd, ...args] = argv;

    if (cmd === "sqlite3") {
      const dot = args.at(-1) ?? "";
      const backup = /^\.backup "(.*)"$/.exec(dot);

      if (backup) {
        const dest = backup[1]!.replace(/\\(["\\])/g, "$1");
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(args.at(-2)!, dest);

        return ok();
      }

      const vacuum = /^vacuum into '(.*)'$/.exec(dot);

      if (vacuum) {
        const dest = vacuum[1]!.replaceAll("''", "'");
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(args.at(-2)!, dest);

        return ok();
      }

      return ok("ok\n");
    }

    if (cmd === "restic") {
      if (args[0] === "cat") {
        return repo.exists
          ? ok()
          : {
              code: 10,
              stdout: "",
              stderr:
                "Fatal: repository does not exist\nIs there a repository at the following location?\n",
            };
      }
      if (args[0] === "init") {
        return ((repo.exists = true), ok());
      }
      if (args[0] === "backup") {
        return ((repo.stage = args.at(-1)), ok());
      }
      if (args[0] === "restore") {
        if (repo.stage === undefined) {
          return {
            code: 1,
            stdout: "",
            stderr: "Fatal: no matching ID found for prefix latest\n",
          };
        }
        const target = args[args.indexOf("--target") + 1]!;

        if (existsSync(repo.stage)) {
          cpSync(repo.stage, join(target, repo.stage), { recursive: true });
        }
        return ok();
      }

      return ok();
    }

    return undefined;
  };

  return repo;
};
