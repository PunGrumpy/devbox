import { Effect, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import http from "node:http";
import { BindHost, Port } from "../machine/config.ts";
import { Output } from "../output.ts";
import {
  type MachineState,
  origin,
  type Snapshot,
  snapshotFlags,
  takeSnapshot,
} from "./machines.ts";
import page from "./page.html" with { type: "text" };

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

// Bun types every .html import as an HTMLBundle; `type: "text"` makes it the file's text.
const TEMPLATE = String(page);

// `<` as < keeps a label such as "</script>" from closing the script tag it sits in.
const renderPage = (snapshot: HubSnapshot): string =>
  TEMPLATE.replace('"__DEVBOX_SNAPSHOT__"', () =>
    JSON.stringify(snapshot).replaceAll("<", "\\u003c"),
  );

type Reply = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

const NO_STORE = { "cache-control": "no-store" };
const TEXT = { "content-type": "text/plain; charset=utf-8" };

export const route = (method: string, url: string, snapshot: HubSnapshot): Reply => {
  const { pathname } = new URL(url, "http://hub");
  if (pathname !== "/" && pathname !== "/api/machines")
    return { status: 404, headers: TEXT, body: "not found\n" };
  if (method !== "GET")
    return { status: 405, headers: { ...TEXT, allow: "GET" }, body: "method not allowed\n" };
  if (pathname === "/")
    return {
      status: 200,
      headers: { ...NO_STORE, "content-type": "text/html; charset=utf-8" },
      body: renderPage(snapshot),
    };
  return {
    status: 200,
    headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" },
    body: `${JSON.stringify(snapshot, null, 2)}\n`,
  };
};

export class HubFailed extends Schema.TaggedError<HubFailed>()("HubFailed", {
  message: Schema.String,
  hint: Schema.optional(Schema.String),
}) {}

const listen = (host: string, port: number, latest: () => HubSnapshot) =>
  Effect.acquireRelease(
    Effect.callback<http.Server, HubFailed>((resume) => {
      const server = http.createServer((req, res) => {
        const reply = route(req.method ?? "GET", req.url ?? "/", latest());
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
    ...snapshotFlags,
  },
  ({ host, port, t3, t3Port }) =>
    Effect.gen(function* () {
      const out = yield* Output;
      const first = yield* takeSnapshot({ t3, t3Port });
      let latest: HubSnapshot = { ...first, history: nextHistory(undefined, first) };
      yield* listen(host, port, () => latest);
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
    "Serve a page of your machines and the same data at /api/machines, refreshed every minute",
  ),
);
