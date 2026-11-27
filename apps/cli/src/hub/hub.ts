import { readFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Config,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Schema,
  Semaphore,
} from "effect";
import { Command, Flag } from "effect/cli";

import { BindHost, Port } from "../machine/config.ts";
import { Host } from "../machine/host.ts";
import { Locations } from "../migrate/locations.ts";
import { Output } from "../output.ts";
import {
  admit,
  answer,
  CLOUDFLARE_PATH,
  cloudflareAsk,
  MAX_CLOUDFLARE_BYTES,
  machineAction,
} from "./ask.ts";
import type { Ask } from "./ask.ts";
import { loadCloudflare } from "./cloudflare-auth.ts";
import type { CloudflareLogin } from "./cloudflare-auth.ts";
import { cloudflareCommand } from "./cloudflare-command.ts";
import { header, listen, readBody } from "./listen.ts";
import {
  crossSite,
  LOGGED_OUT,
  loggedIn,
  login,
  logout,
  MAX_LOGIN_BYTES,
  refuse,
} from "./login.ts";
import type { HubRequest, Reply } from "./login.ts";
import { origin, snapshotFlags, takeSnapshot } from "./machines.ts";
import type { Machine, MachineState, Snapshot } from "./machines.ts";
import { restore, serialize } from "./saved.ts";
import { hubSecrets, keyCommand, tokenCommand } from "./secrets.ts";
import { loadTunnels, tunnelOf } from "./tunnel.ts";
import { nextWatch, sentence, webhookBody } from "./watch.ts";
import type { Notice, Watch } from "./watch.ts";

export type History = {
  readonly sampleSeconds: number;
  readonly startedAt: string;
  readonly states: Readonly<Record<string, string>>;
  /** T3 Code's answer time in whole milliseconds per sample, null where it did not answer. */
  readonly latency: Readonly<Record<string, readonly (number | null)[]>>;
};

/** A machine as the hub shows it, with the address of its tunnel once it answers. */
export type HubMachine = Machine & {
  readonly tunnel: { readonly url: string } | null;
};

/** What a check finds, which the hub keeps until the next one. */
export type Sample = Snapshot & {
  readonly history: History;
  /** The newest T3 Code on the nightly channel, or null while the registry has not answered. */
  readonly latest: { readonly t3: string | null };
  /** The hub's public key in base64url, which a spoke is told to trust. */
  readonly key: string;
};

/** The last check, with what the hub has made and how it signs in to Cloudflare as they are now. */
export type HubSnapshot = Omit<Sample, "machines"> & {
  readonly machines: readonly HubMachine[];
  /** The zone the hub publishes machines in and how it signs in, or null with no login saved. */
  readonly cloudflare: {
    readonly zone: string;
    readonly kind: CloudflareLogin["kind"];
  } | null;
};

const SAMPLE_SECONDS = 60;

// 24 hours of samples.
export const HISTORY_LIMIT = 1440;

const CODE: Record<MachineState, string> = {
  t3: "2",
  online: "1",
  offline: "0",
};

const UNKNOWN = " ";

/**
 * One character per sample, newest last. A machine seen late is padded on the left, a machine
 * missing from a sample gets a blank, and one blank for the whole window is dropped. Latency
 * follows the same alignment, with null where T3 Code did not answer.
 */
export const nextHistory = (
  previous: History | undefined,
  snapshot: Snapshot
): History => {
  const before = previous?.states ?? {};
  const beforeLatency = previous?.latency ?? {};

  const width = Math.max(
    0,
    ...Object.values(before).map((states) => states.length)
  );

  const now = new Map<
    string,
    { readonly state: string; readonly latency: number | null }
  >();

  for (const m of snapshot.machines) {
    if (!now.has(m.name))
      now.set(m.name, {
        state: CODE[m.state],
        latency:
          m.t3 === null || m.t3.latencyMs === null
            ? null
            : Math.round(m.t3.latencyMs),
      });
  }

  const states: Record<string, string> = {};
  const latency: Record<string, readonly (number | null)[]> = {};

  for (const name of new Set([...Object.keys(before), ...now.keys()])) {
    const sample = now.get(name);

    const next =
      `${(before[name] ?? "").padStart(width, UNKNOWN)}${sample?.state ?? UNKNOWN}`.slice(
        -HISTORY_LIMIT
      );

    if (next.trim() === "") {
      continue;
    }

    const prior = beforeLatency[name] ?? [];

    const padded = [
      ...Array<null>(Math.max(0, width - prior.length)).fill(null),
      ...prior,
    ];

    const aligned = padded.slice(padded.length - width);
    states[name] = next;
    latency[name] = [...aligned, sample?.latency ?? null].slice(-HISTORY_LIMIT);
  }

  return {
    sampleSeconds: SAMPLE_SECONDS,
    startedAt: previous?.startedAt ?? snapshot.generatedAt,
    states,
    latency,
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

      const path = resolve(
        root,
        `.${wanted.endsWith("/") ? `${wanted}index.html` : wanted}`
      );

      if (!path.startsWith(`${root}${sep}`)) {
        return undefined;
      }

      return { body: readFileSync(path), path };
    } catch {
      return undefined;
    }
  };

// Next names these files by their content, so a browser may keep them for good.
const HASHED = "/_next/static/";

export type { HubRequest, Reply } from "./login.ts";

const NO_STORE = { "cache-control": "no-store" };
const TEXT = { "content-type": "text/plain; charset=utf-8" };

const NOT_BUILT =
  "The hub page is not built. In the devbox checkout run `bun install` and `bun run build` in apps/hub/, or pass --ui.\n";

const LOGIN_PATH = "/api/login";

/** The requests whose body the hub reads, and how many bytes of it at most. */
const BODIES: ReadonlyMap<string, number> = new Map([
  [`POST ${LOGIN_PATH}`, MAX_LOGIN_BYTES],
  [`PUT ${CLOUDFLARE_PATH}`, MAX_CLOUDFLARE_BYTES],
]);

const isApi = (pathname: string) =>
  pathname === "/api" || pathname.startsWith("/api/");

const onlyPost = refuse(405, "Use POST.", { allow: "POST" });

const page = (
  method: string,
  pathname: string,
  asset: (pathname: string) => Asset | undefined
): Reply => {
  if (method !== "GET") {
    return {
      status: 405,
      headers: { ...TEXT, allow: "GET" },
      body: "method not allowed\n",
    };
  }

  const found = asset(pathname);

  if (found === undefined) {
    return {
      status: 404,
      headers: TEXT,
      body: pathname === "/" ? NOT_BUILT : "not found\n",
    };
  }

  return {
    status: 200,
    headers: {
      "cache-control": pathname.startsWith(HASHED)
        ? "public, max-age=31536000, immutable"
        : "no-store",
      "content-type":
        CONTENT_TYPES[extname(found.path)] ?? "application/octet-stream",
    },
    body: found.body,
  };
};

/** What the hub knows when it answers a request. */
export type HubState = {
  readonly snapshot: HubSnapshot;
  readonly token: string;
  /** Milliseconds since the epoch. */
  readonly now: number;
};

/**
 * The reply to a request, or what to ask a machine's spoke when only it can answer. Every path
 * under /api/ but the login needs a login, and nothing that changes something is taken from a page
 * on another site.
 */
export const route = (
  request: HubRequest,
  hub: HubState,
  asset: (pathname: string) => Asset | undefined
): Reply | Ask => {
  const { method } = request;
  const { pathname } = new URL(request.url, "http://hub");

  if (crossSite(request)) {
    return refuse(403, "This request came from a page on another site.");
  }

  if (!isApi(pathname)) {
    return page(method, pathname, asset);
  }

  if (pathname === LOGIN_PATH) {
    return method === "POST" ? login(request, hub.token, hub.now) : onlyPost;
  }

  const wanted = machineAction(pathname, method);

  if (wanted?.action !== undefined) {
    return admit(
      request,
      { name: wanted.name, action: wanted.action },
      hub.snapshot,
      hub.token,
      hub.now
    );
  }

  if (!loggedIn(request, hub.token, hub.now)) {
    return LOGGED_OUT;
  }

  if (wanted !== undefined) {
    return refuse(405, `Use ${wanted.allow}.`, { allow: wanted.allow });
  }

  if (pathname === "/api/logout") {
    return method === "POST" ? logout : onlyPost;
  }

  if (pathname === CLOUDFLARE_PATH) {
    return cloudflareAsk(request);
  }

  if (pathname !== "/api/machines") {
    return refuse(404, "Nothing is here.");
  }

  if (method !== "GET") {
    return refuse(405, "Use GET.", { allow: "GET" });
  }

  return {
    status: 200,
    headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" },
    body: `${JSON.stringify(hub.snapshot, null, 2)}\n`,
  };
};

const BUILT_PAGE = fileURLToPath(new URL("../../../hub/out", import.meta.url));

/**
 * The last check with each machine's tunnel and the Cloudflare login read from their files now,
 * so a request sees a change the moment it is saved, whoever saved it.
 */
const current = (sample: Sample, home: string) =>
  Effect.gen(function* () {
    const tunnels = yield* loadTunnels(home);
    const saved = yield* loadCloudflare(home);

    return {
      ...sample,
      machines: sample.machines.map((m) => ({
        ...m,
        tunnel: tunnelOf(tunnels, m.name),
      })),
      cloudflare: Option.match(saved, {
        onNone: () => null,
        onSome: ({ zone, login: { kind } }) => ({ zone, kind }),
      }),
    } satisfies HubSnapshot;
  });

export const stateFile = (home: string) =>
  join(home, ".local", "state", "devbox", "hub.json");

const REGISTRY = "https://registry.npmjs.org/t3/nightly";

const Manifest = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String })
);

// Once an hour.
const ASK_LATEST_EVERY = 60;

const latestT3 = Effect.gen(function* () {
  const host = yield* Host;

  return Option.flatMap(yield* host.fetchText(REGISTRY, 10_000), ({ body }) =>
    Option.map(
      Schema.decodeUnknownOption(Manifest)(body),
      ({ version }) => version
    )
  );
});

/** The webhook the owner named, or none when it is unset or not a URL. */
const webhook = Effect.gen(function* () {
  const out = yield* Output;

  const named = Option.getOrElse(
    yield* Config.option(Config.String("DEVBOX_HUB_NOTIFY")),
    () => ""
  );

  if (named === "") {
    return Option.none<URL>();
  }

  if (URL.canParse(named)) {
    return Option.some(new URL(named));
  }

  yield* out.warn("DEVBOX_HUB_NOTIFY is not a URL, so nothing will be sent");

  return Option.none<URL>();
}).pipe(Effect.orDie);

export const hub = Command.make(
  "hub",
  {
    host: Flag.String("host").pipe(
      Flag.withDescription(
        "address to listen on, for example a Tailscale IP (everything under /api/ needs a login)"
      ),
      Flag.withSchema(BindHost),
      Flag.withDefault("127.0.0.1")
    ),
    port: Flag.Int("port").pipe(
      Flag.withDescription("port to listen on"),
      Flag.withSchema(Port),
      Flag.withDefault(3780)
    ),
    ui: Flag.String("ui").pipe(
      Flag.withDescription(
        "directory of the built page (default apps/hub/out in this checkout)"
      ),
      Flag.withDefault(BUILT_PAGE)
    ),
    ...snapshotFlags,
  },
  ({ host, port, ui, t3, t3Port, spokePort }) =>
    Effect.gen(function* () {
      const out = yield* Output;
      const computer = yield* Host;
      const fs = yield* FileSystem.FileSystem;
      const { home } = yield* Locations;
      const file = stateFile(home);
      const secrets = yield* hubSecrets(home);
      const context = yield* Effect.context<Host | FileSystem.FileSystem>();
      const tunnels = yield* Semaphore.make(1);
      const notify = yield* webhook;

      const resumed = yield* fs.readFileString(file).pipe(
        Effect.map((text) => restore(text, Date.now(), HISTORY_LIMIT)),
        Effect.orElseSucceed(() => Option.none())
      );

      let history: History | undefined =
        Option.getOrUndefined(resumed)?.history;

      let watch: Watch | undefined = Option.getOrUndefined(resumed)?.watch;
      let newest: string | null = null;
      let sendFailed = false;

      const send = (url: URL, notice: Notice) =>
        Effect.gen(function* () {
          const sent = yield* computer.post(
            url.href,
            webhookBody(url, sentence(notice)),
            10_000
          );

          const failed = Option.isNone(sent);

          if (failed && !sendFailed) {
            yield* out.warn("a notification could not be sent");
          }

          sendFailed = failed;
        });

      const sample = (count: number) =>
        Effect.gen(function* () {
          const snapshot = yield* takeSnapshot({
            t3,
            t3Port,
            spokePort,
            hubKey: secrets.fingerprint,
          });

          if (count % ASK_LATEST_EVERY === 0) {
            newest = Option.getOrElse(yield* latestT3, () => newest);
          }

          const watched = nextWatch(watch, snapshot);

          const saved = {
            history: nextHistory(history, snapshot),
            watch: watched.watch,
          };

          history = saved.history;
          watch = saved.watch;
          yield* fs
            .makeDirectory(dirname(file), { recursive: true })
            .pipe(
              Effect.andThen(
                fs.writeFileString(
                  `${file}.tmp`,
                  serialize(saved, DateTime.formatIso(yield* DateTime.now))
                )
              ),
              Effect.andThen(fs.rename(`${file}.tmp`, file)),
              Effect.ignore
            );

          if (Option.isSome(notify)) {
            yield* Effect.forkScoped(
              Effect.forEach(
                watched.notices,
                (notice) => send(notify.value, notice),
                {
                  discard: true,
                }
              )
            );
          }

          return {
            ...snapshot,
            history: saved.history,
            latest: { t3: newest },
            key: secrets.key,
          } satisfies Sample;
        });

      let latest = yield* sample(0);
      const asset = assetsIn(ui);
      yield* listen(host, port, (req, res) => {
        const respond = (reply: Reply) => {
          res.writeHead(reply.status, reply.headers);
          res.end(reply.body);
        };

        const url = req.url ?? "/";
        const method = req.method ?? "GET";
        const { pathname } = new URL(url, "http://hub");
        const limit = BODIES.get(`${method} ${pathname}`);

        if (method !== "GET" && limit === undefined) {
          res.setHeader("connection", "close");
        }

        Promise.all([
          limit === undefined ? Promise.resolve("") : readBody(req, limit),
          Effect.runPromiseWith(context)(current(latest, home)),
        ])
          .then(([text, snapshot]) => {
            const routed = route(
              {
                method,
                url,
                headers: {
                  authorization: header(req, "authorization"),
                  cookie: header(req, "cookie"),
                  origin: header(req, "origin"),
                  host: header(req, "host"),
                  "x-forwarded-host": header(req, "x-forwarded-host"),
                },
                body: text,
              },
              { snapshot, token: secrets.token, now: Date.now() },
              asset
            );

            if ("status" in routed) {
              return routed;
            }

            return Effect.runPromiseWith(context)(
              answer(routed, {
                secrets,
                home,
                spokePort,
                t3Port,
                tunnels,
                names: snapshot.machines.map((m) => m.name),
              })
            );
          })
          .then(respond, () =>
            respond({ status: 500, headers: TEXT, body: "the hub failed\n" })
          );
      });
      yield* out.log(
        `hub: ${origin(host, port)}/ and /api/machines, checking every ${SAMPLE_SECONDS}s`
      );
      let count = 0;

      return yield* Effect.suspend(() => {
        count += 1;

        return sample(count);
      }).pipe(
        Effect.map((next) => {
          latest = next;
        }),
        Effect.delay(`${SAMPLE_SECONDS} seconds`),
        Effect.forever
      );
    }).pipe(Effect.scoped)
).pipe(
  Command.withDescription(
    "Serve the hub page and your machines as JSON at /api/machines, refreshed every minute"
  ),
  Command.withSubcommands([keyCommand, tokenCommand, cloudflareCommand])
);
