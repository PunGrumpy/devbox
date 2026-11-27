import { Database } from "bun:sqlite";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { Ran } from "../../src/machine/host.ts";
import type { FakeMachine } from "./host.ts";

const ok = (stdout = "") => ({ stdout, code: 0, stderr: "" }) satisfies Ran;

const fail = (code: number, stderr: string) =>
  ({ code, stderr, stdout: "" }) satisfies Ran;

export const makeSqlite = (file: string, rows: number, wal = false) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);

  if (wal) {
    db.run("pragma journal_mode = wal");
  }

  db.run("create table if not exists t (n integer)");

  for (let i = 0; i < rows; i += 1) {
    db.run("insert into t values (?)", [i]);
  }

  db.close();
};

export const write = (file: string, content: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};

export const sourcesFile = (home: string, text: string) => {
  write(path.join(home, ".config/devbox/backup/sources"), text);
};

export const envFile = (home: string, text: string) => {
  write(path.join(home, ".config/devbox/backup/env"), text);
};

export interface FakeRepo {
  exists: boolean;
  failCheck: boolean;
  stage?: string;
}

const copyInto = (source: string | undefined, dest: string) => {
  if (source === undefined) {
    return fail(1, "fake sqlite3: no database to copy");
  }

  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(source, dest);

  return ok();
};

const sqlite3 = (args: readonly string[]) => {
  const dot = args.at(-1) ?? "";
  const backup = /^\.backup "(?<dest>.*)"$/u.exec(dot)?.groups?.dest;

  if (backup !== undefined) {
    return copyInto(
      args.at(-2),
      backup.replaceAll(/\\(?<escaped>["\\])/gu, "$<escaped>")
    );
  }

  const vacuum = /^vacuum into '(?<dest>.*)'$/u.exec(dot)?.groups?.dest;

  if (vacuum !== undefined) {
    return copyInto(args.at(-2), vacuum.replaceAll("''", "'"));
  }

  return ok("ok\n");
};

const restore = (repo: FakeRepo, args: readonly string[]) => {
  if (repo.stage === undefined) {
    return fail(1, "Fatal: no matching ID found for prefix latest\n");
  }

  const target = args[args.indexOf("--target") + 1];

  if (target === undefined) {
    return fail(1, "Fatal: restore needs --target\n");
  }

  if (existsSync(repo.stage)) {
    cpSync(repo.stage, path.join(target, repo.stage), { recursive: true });
  }

  return ok();
};

const restic = (repo: FakeRepo, args: readonly string[]) => {
  if (args[0] === "cat") {
    return repo.exists
      ? ok()
      : fail(
          10,
          "Fatal: repository does not exist\nIs there a repository at the following location?\n"
        );
  }

  if (args[0] === "init") {
    repo.exists = true;

    return ok();
  }

  if (args[0] === "backup") {
    repo.stage = args.at(-1);

    return ok();
  }

  if (args[0] === "restore") {
    return restore(repo, args);
  }

  return ok();
};

export const withBackupTools = (m: FakeMachine, given?: FakeRepo) => {
  const repo = given ?? { exists: false, failCheck: false };
  m.binaries.add("restic");
  m.binaries.add("sqlite3");
  m.respond = (argv) => {
    const [cmd, ...args] = argv;

    if (cmd === "sqlite3") {
      return sqlite3(args);
    }

    if (cmd === "restic") {
      return restic(repo, args);
    }
  };

  return repo;
};
