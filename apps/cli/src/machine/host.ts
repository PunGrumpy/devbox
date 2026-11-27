import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statfsSync,
} from "node:fs";
import {
  availableParallelism,
  freemem,
  hostname,
  loadavg,
  totalmem,
  userInfo,
} from "node:os";
import path from "node:path";

import { Context, Effect, Layer, Option } from "effect";

import { vitalsOf } from "../spoke/vitals.ts";
import type { Vitals } from "../spoke/vitals.ts";

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly stdin?: string;
  readonly inherit?: boolean;
  readonly timeoutMs?: number;
}

export const TIMED_OUT = 124;

export interface Proc {
  readonly pid: number;
  readonly argv: readonly string[];
}

export interface Fetched {
  readonly body: string;
  readonly ms: number;
}

export interface Request {
  readonly method: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** What a server answered, whatever the status. */
export interface Answer {
  readonly status: number;
  readonly body: string;
}

const MAX_ANSWER_BYTES = 1024 * 1024;

const capped = async (response: Response): Promise<string | undefined> => {
  if (Number(response.headers.get("content-length") ?? 0) > MAX_ANSWER_BYTES) {
    return undefined;
  }

  const reader = response.body?.getReader();

  if (reader === undefined) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.byteLength;

    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);

      return undefined;
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf-8");
};

export class Host extends Context.Service<
  Host,
  {
    readonly hostname: string;
    readonly user: string;
    readonly etc: string;
    readonly path: string;
    readonly self: readonly string[];
    readonly systemd: boolean;
    /** `process.platform`, such as linux or darwin. */
    readonly platform: string;
    readonly run: (
      argv: readonly string[],
      options?: RunOptions
    ) => Effect.Effect<Ran>;
    readonly which: (name: string) => Effect.Effect<boolean>;
    readonly processes: Effect.Effect<readonly Proc[]>;
    readonly spawnDetached: (
      argv: readonly string[],
      options: {
        readonly env: Readonly<Record<string, string>>;
        readonly log: string;
      }
    ) => Effect.Effect<number>;
    readonly stop: (pid: number) => Effect.Effect<void>;
    readonly answers: (port: number, address: string) => Effect.Effect<boolean>;
    /** The body of a 200 answer and how long it took, or none for anything else. */
    readonly fetchText: (
      url: string,
      timeoutMs: number
    ) => Effect.Effect<Option.Option<Fetched>>;
    /** The body of a 2xx answer to a POST, or none for anything else. */
    readonly post: (
      url: string,
      message: {
        readonly body: string;
        readonly contentType: string;
        readonly headers?: Readonly<Record<string, string>>;
      },
      timeoutMs: number
    ) => Effect.Effect<Option.Option<string>>;
    /**
     * The answer to any request, whatever its status, or none when nothing answered in time or the
     * answer was larger than devbox reads.
     */
    readonly request: (
      url: string,
      request: Request,
      timeoutMs: number
    ) => Effect.Effect<Option.Option<Answer>>;
    /** Load, memory, and the disk that holds `dir`. */
    readonly vitals: (dir: string) => Effect.Effect<Vitals>;
    readonly readLine: Effect.Effect<string>;
  }
>()("devbox/machine/Host") {
  static readonly layer = Layer.sync(Host, () => ({
    hostname: hostname(),
    user:
      Bun.spawnSync(["id", "-un"]).stdout.toString().trim() ||
      userInfo().username,
    etc: "/etc",
    path: process.env.PATH ?? "",
    self: Bun.main.endsWith(".ts")
      ? [process.execPath, Bun.main]
      : [process.execPath],
    systemd: existsSync("/run/systemd/system"),
    platform: process.platform,
    run: (argv, options = {}) =>
      Effect.promise(async (): Promise<Ran> => {
        try {
          const started = performance.now();

          const child = Bun.spawn([...argv], {
            env: { ...process.env, ...options.env },
            cwd: options.cwd ?? "/",
            stdin:
              options.stdin === undefined
                ? "ignore"
                : new Blob([options.stdin]),
            stdout: options.inherit ? "inherit" : "pipe",
            stderr: options.inherit ? "inherit" : "pipe",
            ...(options.timeoutMs === undefined
              ? {}
              : { timeout: options.timeoutMs }),
          });

          const [stdout, stderr, code] = await Promise.all([
            child.stdout ? new Response(child.stdout).text() : "",
            child.stderr ? new Response(child.stderr).text() : "",
            child.exited,
          ]);

          return {
            code: timedOut(options.timeoutMs, started, code) ? TIMED_OUT : code,
            stdout,
            stderr,
          };
        } catch (error) {
          return { code: 127, stdout: "", stderr: String(error) };
        }
      }),
    which: (name) => Effect.sync(() => Bun.which(name) !== null),
    processes: Effect.sync(() =>
      readdirSync("/proc").flatMap((entry) => {
        if (!/^\d+$/.test(entry)) {
          return [];
        }

        try {
          const argv = readFileSync(`/proc/${entry}/cmdline`, "utf-8")
            .split("\0")
            .slice(0, -1);

          return [{ pid: Number(entry), argv }];
        } catch {
          return [];
        }
      })
    ),
    spawnDetached: (argv, { env, log }) =>
      Effect.sync(() => {
        mkdirSync(path.dirname(log), { recursive: true });
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

        for (let i = 0; i < 50 && alive(pid); i += 1) {
          yield* Effect.sleep("200 millis");
        }

        if (alive(pid)) {
          signal(pid, "SIGKILL");
        }
      }),
    answers: (port, address) =>
      Effect.promise(() =>
        fetch(
          `http://${address.includes(":") ? `[${address}]` : address}:${port}/`,
          {
            redirect: "manual",
            signal: AbortSignal.timeout(2000),
          }
        ).then(
          (response) => response.status < 500,
          () => false
        )
      ),
    fetchText: (url, timeoutMs) =>
      Effect.promise(async (): Promise<Option.Option<Fetched>> => {
        const started = performance.now();

        try {
          const response = await fetch(url, {
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
          });

          if (response.status !== 200) {
            return Option.none();
          }

          const body = await capped(response);

          if (body === undefined) {
            return Option.none();
          }

          return Option.some({
            body,
            ms: Math.round(performance.now() - started),
          });
        } catch {
          return Option.none();
        }
      }),
    post: (url, { body, contentType, headers = {} }, timeoutMs) =>
      Effect.promise(async (): Promise<Option.Option<string>> => {
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: { ...headers, "content-type": contentType },
            body,
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
          });

          if (!response.ok) {
            return Option.none();
          }

          return Option.fromUndefinedOr(await capped(response));
        } catch {
          return Option.none();
        }
      }),
    request: (url, { method, headers = {}, body }, timeoutMs) =>
      Effect.promise(async (): Promise<Option.Option<Answer>> => {
        try {
          const response = await fetch(url, {
            method,
            headers,
            ...(body === undefined ? {} : { body }),
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
          });

          return Option.map(
            Option.fromUndefinedOr(await capped(response)),
            (text) => ({
              status: response.status,
              body: text,
            })
          );
        } catch {
          return Option.none();
        }
      }),
    vitals: (dir) =>
      Effect.sync(() => {
        const disk = (() => {
          try {
            return statfsSync(dir);
          } catch {
            return statfsSync("/");
          }
        })();

        return vitalsOf({
          load1: loadavg()[0] ?? 0,
          cores: availableParallelism(),
          memory: { total: totalmem(), available: freemem() },
          disk: {
            blocks: disk.blocks,
            free: disk.bfree,
            blockSize: disk.bsize,
          },
        });
      }),
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
                } else {
                  next();
                }
              },
              () => resolve(line)
            );
          };

          next();
        })
    ),
  }));
}

const timedOut = (
  limit: number | undefined,
  started: number,
  code: number
): boolean =>
  limit !== undefined && code !== 0 && performance.now() - started >= limit;

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
