import { Effect, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { readFileSync } from "node:fs";
import http from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BindHost, Port } from "../machine/config.ts";
import { Output } from "../output.ts";
import {
  type MachineState,
  origin,
  type Snapshot,
  snapshotFlags,
  takeSnapshot,
} from "./machines.ts";

export type History = {
  readonly sampleSeconds: number;
  readonly startedAt: string;
  readonly states: Readonly<Record<string, string>>;
};

export type HubSnapshot = Snapshot & { readonly history: History };

const SAMPLE_SECONDS = 60;
// 24 hours of samples.
export const HISTORY_LIMIT = 1440;
const CODE: Record<MachineState, string> = { t3: "2", online: "1", offline: "0" };
const UNKNOWN = " ";

/**
 * One character per sample, newest last. A machine seen late is padded on the left, a machine
 * missing from a sample gets a blank, and one blank for the whole window is dropped.
 */
export const nextHistory = (previous: History | undefined, snapshot: Snapshot): History => {
  const before = previous?.states ?? {};
  const width = Math.max(0, ...Object.values(before).map((states) => states.length));
  const now = new Map<string, string>();
  for (const m of snapshot.machines) if (!now.has(m.name)) now.set(m.name, CODE[m.state]);
  const states: Record<string, string> = {};
  for (const name of new Set([...Object.keys(before), ...now.keys()])) {
    const next =
      `${(before[name] ?? "").padStart(width, UNKNOWN)}${now.get(name) ?? UNKNOWN}`.slice(
        -HISTORY_LIMIT,
      );
    if (next.trim() !== "") states[name] = next;
  }
  return {
    sampleSeconds: SAMPLE_SECONDS,
    startedAt: previous?.startedAt ?? snapshot.generatedAt,
    states,
  };
};

export type Asset = { readonly body: Uint8Array; readonly path: string };

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Reads a request path from the built page in `dir`, and nothing from outside it. */
export const assetsIn =
  (dir: string) =>
  (pathname: string): Asset | undefined => {
    const root = resolve(dir);
    try {
      const wanted = decodeURIComponent(pathname);
      const path = resolve(root, `.${wanted.endsWith("/") ? `${wanted}index.html` : wanted}`);
      if (!path.startsWith(`${root}${sep}`)) return undefined;
      return { body: readFileSync(path), path };
    } catch {
      return undefined;
    }
  };

// Next names these files by their content, so a browser may keep them for good.
const HASHED = "/_next/static/";

type Reply = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
};

const NO_STORE = { "cache-control": "no-store" };
const TEXT = { "content-type": "text/plain; charset=utf-8" };

const NOT_BUILT =
  "The hub page is not built. In the devbox checkout run `bun install` and `bun run build` in hub/, or pass --ui.\n";

export const route = (
  method: string,
  url: string,
  snapshot: HubSnapshot,
  asset: (pathname: string) => Asset | undefined,
): Reply => {
  const { pathname } = new URL(url, "http://hub");
  if (method !== "GET")
    return { status: 405, headers: { ...TEXT, allow: "GET" }, body: "method not allowed\n" };
  if (pathname === "/api/machines")
    return {
      status: 200,
      headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" },
      body: `${JSON.stringify(snapshot, null, 2)}\n`,
    };
  const found = asset(pathname);
  if (found === undefined)
    return { status: 404, headers: TEXT, body: pathname === "/" ? NOT_BUILT : "not found\n" };
  return {
    status: 200,
    headers: {
      "cache-control": pathname.startsWith(HASHED)
        ? "public, max-age=31536000, immutable"
        : "no-store",
      "content-type": CONTENT_TYPES[extname(found.path)] ?? "application/octet-stream",
    },
    body: found.body,
  };
};

export class HubFailed extends Schema.TaggedError<HubFailed>()("HubFailed", {
  message: Schema.String,
  hint: Schema.optional(Schema.String),
}) {}

const listen = (
  host: string,
  port: number,
  latest: () => HubSnapshot,
  asset: (pathname: string) => Asset | undefined,
) =>
  Effect.acquireRelease(
    Effect.callback<http.Server, HubFailed>((resume) => {
      const server = http.createServer((req, res) => {
        const reply = route(req.method ?? "GET", req.url ?? "/", latest(), asset);
        res.writeHead(reply.status, reply.headers);
        res.end(reply.body);
      });
      server.once("error", (error: NodeJS.ErrnoException) =>
        resume(
          Effect.fail(
            new HubFailed({
              message: `cannot listen on ${host}:${port}: ${error.code ?? error.message}`,
              hint: "pass another --port, or an address this machine has to --host",
            }),
          ),
        ),
      );
      server.listen(port, host, () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

const BUILT_PAGE = fileURLToPath(new URL("../../hub/out", import.meta.url));

export const hub = Command.make(
  "hub",
  {
    host: Flag.String("host").pipe(
      Flag.withDescription(
        "address to listen on, for example a Tailscale IP (the page has no login)",
      ),
      Flag.withSchema(BindHost),
      Flag.withDefault("127.0.0.1"),
    ),
    port: Flag.Int("port").pipe(
      Flag.withDescription("port to listen on"),
      Flag.withSchema(Port),
      Flag.withDefault(3780),
    ),
    ui: Flag.String("ui").pipe(
      Flag.withDescription("directory of the built page (default hub/out in this checkout)"),
      Flag.withDefault(BUILT_PAGE),
    ),
    ...snapshotFlags,
  },
  ({ host, port, ui, t3, t3Port }) =>
    Effect.gen(function* () {
      const out = yield* Output;
      const first = yield* takeSnapshot({ t3, t3Port });
      let latest: HubSnapshot = { ...first, history: nextHistory(undefined, first) };
      yield* listen(host, port, () => latest, assetsIn(ui));
      yield* out.log(
        `hub: ${origin(host, port)}/ and /api/machines, checking every ${SAMPLE_SECONDS}s`,
      );
      return yield* takeSnapshot({ t3, t3Port }).pipe(
        Effect.map((next) => {
          latest = { ...next, history: nextHistory(latest.history, next) };
        }),
        Effect.delay(`${SAMPLE_SECONDS} seconds`),
        Effect.forever,
      );
    }).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Serve the hub page and your machines as JSON at /api/machines, refreshed every minute",
  ),
);
