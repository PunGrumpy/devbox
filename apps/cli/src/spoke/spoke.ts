import type http from "node:http";
import path from "node:path";

import { Effect, Exit, FileSystem, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";

import { header, listen, readBody } from "../hub/listen.ts";
import { BARE_METAL, origin } from "../hub/machines.ts";
import { BindHost, machineFile, pathsOf, Port } from "../machine/config.ts";
import { Host } from "../machine/host.ts";
import { Pairing, pairingUrl } from "../machine/pair.ts";
import {
  isTunnelToken,
  isTunnelUrl,
  tunnelTokenFile,
  withTunnel,
} from "../machine/tunnel.ts";
import { Locations } from "../migrate/locations.ts";
import { Output } from "../output.ts";
import {
  fingerprint,
  handOut,
  KEY_HEADER,
  newNonce,
  PublicKey,
  SIGNATURE_HEADER,
  verifyRequest,
} from "./signed.ts";
import type { Challenges, Do, Fields } from "./signed.ts";
import { SPOKE_PORT } from "./vitals.ts";
import type { SelfKind, Vitals } from "./vitals.ts";

/** What this machine is, from what it can see of itself. */
export const kindHere = Effect.gen(function* () {
  const host = yield* Host;

  if (host.platform === "darwin") {
    return "mac" satisfies SelfKind;
  }

  const ran = yield* host.run(["systemd-detect-virt"], { timeoutMs: 3000 });
  const virt = ran.code === 0 ? ran.stdout.trim() || BARE_METAL : BARE_METAL;

  if (virt === "wsl") {
    return "wsl" satisfies SelfKind;
  }

  return (virt === BARE_METAL ? "computer" : "vm") satisfies SelfKind;
});

const SetUp = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.String,
    up: Schema.optional(Schema.Array(Schema.String)),
  })
);

const lastSetUp = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const text = yield* fs
      .readFileString(machineFile(home))
      .pipe(Effect.option);

    return Option.flatMap(text, (t) =>
      Option.flatMap(Schema.decodeUnknownOption(SetUp)(t), ({ data, up }) =>
        up === undefined ? Option.none() : Option.some({ data, up })
      )
    );
  });

type ReplyBody =
  | { readonly error: string }
  | { readonly asked: true }
  | { readonly url: string }
  | { readonly nonce: string }
  | {
      readonly kind: SelfKind;
      readonly vitals: Vitals;
      readonly trusts: readonly string[];
    };

interface Reply {
  readonly status: number;
  readonly body: ReplyBody;
}

const reply = (status: number, body: ReplyBody) =>
  ({ status, body }) satisfies Reply;

const refuse = (status: number, error: string) => reply(status, { error });

export const MAX_BODY_BYTES = 4096;

type Action = (
  fields: Fields
) => Effect.Effect<Reply, never, FileSystem.FileSystem>;

const saveToken = (home: string, token: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = tunnelTokenFile(home);
    const temp = `${file}.${newNonce()}`;
    yield* fs.makeDirectory(path.dirname(file), {
      recursive: true,
      mode: 0o700,
    });
    yield* fs.writeFileString(temp, token, { flag: "wx", mode: 0o600 }).pipe(
      Effect.andThen(fs.rename(temp, file)),
      Effect.tapError(() =>
        fs.remove(temp, { force: true }).pipe(Effect.ignore)
      )
    );
  }).pipe(Effect.option);

const removeToken = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(tunnelTokenFile(home), { force: true });
  }).pipe(Effect.option);

const Paired = Schema.fromJsonString(Pairing);
export const PAIR_MS = 25_000;

const singleFlight = <A>(whileRunning: A) => {
  let running = false;

  return <E, R>(run: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      if (running) {
        return Effect.succeed(whileRunning);
      }

      running = true;

      return run.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            running = false;
          })
        )
      );
    });
};

export const spoke = Command.make(
  "spoke",
  {
    host: Flag.String("host").pipe(
      Flag.withDescription("address to listen on, for example a Tailscale IP"),
      Flag.withSchema(BindHost),
      Flag.withDefault("127.0.0.1")
    ),
    port: Flag.Int("port").pipe(
      Flag.withDescription(`port to listen on (default ${SPOKE_PORT})`),
      Flag.withSchema(Port),
      Flag.withDefault(SPOKE_PORT)
    ),
    trust: Flag.String("trust").pipe(
      Flag.withDescription(
        "a hub key, printed by `devbox hub key`, to take signed requests from (repeatable)"
      ),
      Flag.withSchema(PublicKey),
      Flag.atLeast(0)
    ),
  },
  ({ host, port, trust }) =>
    Effect.gen(function* () {
      const out = yield* Output;
      const computer = yield* Host;
      const { home } = yield* Locations;
      const kind = yield* kindHere;
      const trusts = trust.map(fingerprint);

      const context = yield* Effect.context<
        Host | FileSystem.FileSystem | Output
      >();

      let challenges: Challenges = new Map();
      let updating: number | undefined;
      const busy = refuse(409, "devbox up is already running here");
      const oneDevboxUpAtATime = singleFlight(busy);

      const start = (
        said: string,
        flags: (up: readonly string[]) => readonly string[],
        prepare: Effect.Effect<
          Option.Option<Reply>,
          never,
          FileSystem.FileSystem
        >
      ) =>
        Effect.gen(function* () {
          const running = yield* computer.processes;

          if (
            updating !== undefined &&
            running.some((p) => p.pid === updating)
          ) {
            return busy;
          }

          const setUp = yield* lastSetUp(home);

          if (Option.isNone(setUp)) {
            return refuse(
              409,
              "devbox up has not recorded how it set this machine up"
            );
          }

          const failed = yield* prepare;

          if (Option.isSome(failed)) {
            return failed.value;
          }

          updating = yield* computer.spawnDetached(
            [...computer.self, "up", ...flags(setUp.value.up)],
            {
              env: {},
              log: path.join(pathsOf(setUp.value.data).logs, "update.log"),
            }
          );
          yield* out.log(`spoke: ${said}, running devbox up again`);

          return reply(202, { asked: true });
        });

      const nothingFirst = Effect.succeed(Option.none<Reply>());

      const update = () =>
        oneDevboxUpAtATime(
          start("the hub asked for an update", (up) => up, nothingFirst)
        );

      const tunnel = ({ token, url }: Fields) => {
        if (token === undefined || !isTunnelToken(token)) {
          return Effect.succeed(
            refuse(400, "a tunnel request needs a tunnel token")
          );
        }

        if (url === undefined || !isTunnelUrl(url)) {
          return Effect.succeed(
            refuse(
              400,
              "a tunnel request needs an https origin with nothing after the host name"
            )
          );
        }

        return oneDevboxUpAtATime(
          start(
            `the hub asked to publish this machine at ${url}`,
            (up) => withTunnel(up, Option.some(url)),
            Effect.map(saveToken(home, token), (saved) =>
              Option.isSome(saved)
                ? Option.none()
                : Option.some(
                    refuse(500, "this spoke could not save the tunnel token")
                  )
            )
          )
        );
      };

      const untunnel = () =>
        oneDevboxUpAtATime(
          start(
            "the hub asked to take this machine off the internet",
            (up) => withTunnel(up, Option.none()),
            Effect.map(removeToken(home), (removed) =>
              Option.isSome(removed)
                ? Option.none()
                : Option.some(
                    refuse(500, "this spoke could not delete the tunnel token")
                  )
            )
          )
        );

      const pair = () =>
        Effect.gen(function* () {
          const ran = yield* computer.run(
            [...computer.self, "pair", "--json", "--label", "hub"],
            {
              timeoutMs: PAIR_MS,
            }
          );

          const pairing = Schema.decodeUnknownOption(Paired)(ran.stdout.trim());

          if (ran.code !== 0 || Option.isNone(pairing)) {
            return refuse(502, "devbox pair gave no pairing link");
          }

          yield* out.log("spoke: the hub asked for a pairing link");

          return reply(200, { url: pairingUrl(pairing.value) });
        });

      const actions: ReadonlyMap<string, Action> = new Map<Do, Action>([
        ["update", update],
        ["pair", pair],
        ["tunnel", tunnel],
        ["untunnel", untunnel],
      ]);

      const answer = (req: http.IncomingMessage) =>
        Effect.gen(function* () {
          const { pathname } = new URL(req.url ?? "/", "http://spoke");

          if (pathname === "/api/spoke") {
            if (req.method !== "GET") {
              return refuse(405, "use GET");
            }

            const vitals = yield* computer.vitals(home);

            return reply(200, { kind, vitals, trusts });
          }

          if (pathname === "/api/challenge") {
            if (req.method !== "GET") {
              return refuse(405, "use GET");
            }

            const nonce = newNonce();
            challenges = handOut(challenges, nonce, Date.now());

            return reply(200, { nonce });
          }

          if (pathname !== "/api/do") {
            return refuse(404, "not found");
          }

          if (req.method !== "POST") {
            return refuse(405, "use POST");
          }

          const body = yield* Effect.promise(
            async () => await readBody(req, MAX_BODY_BYTES)
          );

          if (body === null) {
            return refuse(413, "a signed request is not that long");
          }

          const verdict = verifyRequest(
            {
              body,
              key: header(req, KEY_HEADER),
              signature: header(req, SIGNATURE_HEADER),
            },
            trust,
            Date.now(),
            challenges
          );

          if (!verdict.ok) {
            return refuse(403, verdict.why);
          }

          ({ challenges } = verdict);
          const action = actions.get(verdict.do);

          if (action === undefined) {
            return refuse(400, "this spoke does not do that");
          }

          return yield* action(verdict.fields);
        });

      const respond = (
        res: http.ServerResponse,
        answered: Exit.Exit<Reply>
      ) => {
        if (Exit.isFailure(answered)) {
          res.writeHead(500);
          res.end();

          return;
        }

        const { status, body } = answered.value;

        const headers: http.OutgoingHttpHeaders = {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        };

        if (status === 413) {
          headers.connection = "close";
        }

        res.writeHead(status, headers);
        res.end(`${JSON.stringify(body)}\n`);
      };

      yield* listen(host, port, (req, res) => {
        Effect.runCallbackWith(context)(answer(req), {
          onExit: (answered) => {
            respond(res, answered);
          },
        });
      });
      yield* out.log(
        `spoke: ${origin(host, port)}/api/spoke, taking requests from ${trusts.length} hub key${trusts.length === 1 ? "" : "s"}`
      );

      return yield* Effect.never;
    }).pipe(Effect.scoped)
).pipe(
  Command.withDescription(
    "Answer the hub with this machine's load, memory and disk, and update, pair or publish T3 Code when a trusted hub asks"
  )
);
