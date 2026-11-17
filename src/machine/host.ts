import { Context, Effect, Layer } from "effect";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname } from "node:path";

export type Ran = { readonly code: number; readonly stdout: string; readonly stderr: string };

export type RunOptions = {
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly stdin?: string;
  readonly inherit?: boolean;
};

export type Proc = { readonly pid: number; readonly argv: ReadonlyArray<string> };

export class Host extends Context.Service<
  Host,
  {
    readonly hostname: string;
    readonly user: string;
    readonly etc: string;
    readonly path: string;
    readonly self: ReadonlyArray<string>;
    readonly systemd: boolean;
    readonly run: (argv: ReadonlyArray<string>, options?: RunOptions) => Effect.Effect<Ran>;
    readonly which: (name: string) => Effect.Effect<boolean>;
    readonly processes: Effect.Effect<ReadonlyArray<Proc>>;
    readonly spawnDetached: (
      argv: ReadonlyArray<string>,
      options: { readonly env: Readonly<Record<string, string>>; readonly log: string },
    ) => Effect.Effect<number>;
    readonly stop: (pid: number) => Effect.Effect<void>;
    readonly answers: (port: number) => Effect.Effect<boolean>;
    readonly readLine: Effect.Effect<string>;
  }
>()("devbox/machine/Host") {
  static readonly layer = Layer.sync(Host, () => ({
    hostname: hostname(),
    user: userInfo().username,
    etc: "/etc",
    path: process.env.PATH ?? "",
    self: Bun.main.endsWith(".ts") ? [process.execPath, Bun.main] : [process.execPath],
    systemd: existsSync("/run/systemd/system"),
    run: (argv, options = {}) =>
      Effect.promise(async (): Promise<Ran> => {
        try {
          const child = Bun.spawn([...argv], {
            env: { ...process.env, ...options.env },
            cwd: options.cwd ?? "/",
            stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
            stdout: options.inherit ? "inherit" : "pipe",
            stderr: options.inherit ? "inherit" : "pipe",
          });
          const [stdout, stderr, code] = await Promise.all([
            child.stdout ? new Response(child.stdout).text() : "",
            child.stderr ? new Response(child.stderr).text() : "",
            child.exited,
          ]);
          return { code, stdout, stderr };
        } catch (error) {
          return { code: 127, stdout: "", stderr: String(error) };
        }
      }),
    which: (name) => Effect.sync(() => Bun.which(name) !== null),
    processes: Effect.sync(() =>
      readdirSync("/proc").flatMap((entry) => {
        if (!/^\d+$/.test(entry)) return [];
        try {
          const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").slice(0, -1);
          return [{ pid: Number(entry), argv }];
        } catch {
          return [];
        }
      }),
    ),
    spawnDetached: (argv, { env, log }) =>
      Effect.sync(() => {
        mkdirSync(dirname(log), { recursive: true });
        const fd = openSync(log, "a");
        const [command = "", ...args] = argv;
        const child = spawn(command, args, {
          detached: true,
          cwd: "/",
          stdio: ["ignore", fd, fd],
          env: { ...process.env, ...env },
        });
        child.unref();
        closeSync(fd);
        return child.pid ?? 0;
      }),
    stop: (pid) =>
      Effect.gen(function* () {
        signal(pid, "SIGTERM");
        for (let i = 0; i < 50 && alive(pid); i += 1) yield* Effect.sleep("200 millis");
        if (alive(pid)) signal(pid, "SIGKILL");
      }),
    answers: (port) =>
      Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/`, {
          redirect: "manual",
          signal: AbortSignal.timeout(2000),
        }).then(
          (response) => response.status < 500,
          () => false,
        ),
      ),
    readLine: Effect.promise(
      () =>
        new Promise<string>((resolve) => {
          const tty = Bun.file("/dev/tty").stream().getReader();
          const decoder = new TextDecoder();
          let line = "";
          const next = (): void => {
            tty.read().then(
              ({ done, value }) => {
                line += value ? decoder.decode(value) : "";
                if (done || line.includes("\n")) {
                  tty.cancel().catch(() => undefined);
                  resolve(line.split("\n")[0] ?? "");
                } else next();
              },
              () => resolve(line),
            );
          };
          next();
        }),
    ),
  }));
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signal = (pid: number, name: NodeJS.Signals): void => {
  try {
    process.kill(-pid, name);
  } catch {
    try {
      process.kill(pid, name);
    } catch {}
  }
};
