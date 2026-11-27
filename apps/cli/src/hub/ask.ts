import { Effect, type FileSystem, Option, Schema, type Semaphore } from "effect";
import { Host } from "../machine/host.ts";
import { type Do, type Fields, Nonce, signRequest } from "../spoke/signed.ts";
import { PAIR_MS } from "../spoke/spoke.ts";
import { bearerOf, forgetCloudflare } from "./cloudflare-auth.ts";
import { ApiToken, cloudflareApi, type PickOne, saveToken } from "./cloudflare.ts";
import { type HubRequest, json, LOGGED_OUT, loggedIn, type Reply, refuse } from "./login.ts";
import { type Machine, origin, type Snapshot, spokeAddresses } from "./machines.ts";
import type { HubSecrets } from "./secrets.ts";
import { NO_LOGIN, publish, StepFailed, TUNNEL_MS, type TunnelJob, unpublish } from "./tunnel.ts";

const Paired = Schema.fromJsonString(
  Schema.Struct({ url: Schema.String.pipe(Schema.check(Schema.isPattern(/^https?:\/\/\S+$/))) }),
);

/** What a request for a machine needs besides the machine. */
export type AskContext = {
  readonly secrets: HubSecrets;
  readonly home: string;
  readonly spokePort: number;
  readonly t3Port: number;
  /** Held by a publish or an unpublish, so two never interleave, whatever machine they are for. */
  readonly tunnels: Semaphore.Semaphore;
  /** Every machine the hub knows, by name. */
  readonly names: ReadonlyArray<string>;
};

type Run = (
  machine: Machine,
  context: AskContext,
) => Effect.Effect<Reply, never, Host | FileSystem.FileSystem>;

const spokeAnswers =
  (
    action: "update" | "pair",
    timeoutMs: number,
    took: (body: string) => Option.Option<Reply>,
    failed: (name: string) => string,
  ): Run =>
  (machine, { secrets, spokePort }) =>
    Effect.map(tellSpoke(machine, action, {}, secrets, spokePort, timeoutMs), (answered) =>
      Option.getOrElse(Option.flatMap(answered, took), () => refuse(502, failed(machine.name))),
    );

const tunnelJob = (machine: Machine, context: AskContext): TunnelJob => ({
  home: context.home,
  machine,
  others: context.names.filter((name) => name !== machine.name),
  t3Port: context.t3Port,
  cloudflare: (account) =>
    Effect.map(
      bearerOf(context.home, account).pipe(
        Effect.mapError(
          (error) => new StepFailed({ step: "sign in to Cloudflare", said: error.message }),
        ),
      ),
      cloudflareApi,
    ),
  tell: (action, fields) =>
    Effect.map(
      tellSpoke(machine, action, fields, context.secrets, context.spokePort, TUNNEL_MS),
      Option.isSome,
    ),
});

const ACTIONS: Readonly<Record<Do, Run>> = {
  update: spokeAnswers(
    "update",
    5000,
    () => Option.some(json(202, { asked: true })),
    (name) => `${name} did not take the update.`,
  ),
  pair: spokeAnswers(
    "pair",
    PAIR_MS + 5000,
    (body) => Option.map(Schema.decodeUnknownOption(Paired)(body), ({ url }) => json(200, { url })),
    (name) => `${name} gave no pairing link.`,
  ),
  tunnel: (machine, context) =>
    context.tunnels.withPermits(1)(publish(tunnelJob(machine, context))),
  untunnel: (machine, context) =>
    context.tunnels.withPermits(1)(unpublish(tunnelJob(machine, context))),
};

export type Action = Do;

const PATHS: Readonly<Record<string, Readonly<Record<string, Action>>>> = {
  update: { POST: "update" },
  pair: { POST: "pair" },
  tunnel: { POST: "tunnel", DELETE: "untunnel" },
};

const MACHINE_PATH = /^\/api\/machines\/(?<name>[^/]+)\/(?<last>update|pair|tunnel)$/;

/**
 * The machine a path names, the action its method asks for (undefined for a method the path does
 * not take), and the methods it takes. Undefined when the path names no machine.
 */
export const machineAction = (
  pathname: string,
  method: string,
):
  | {
      readonly name: string | undefined;
      readonly action: Action | undefined;
      readonly allow: string;
    }
  | undefined => {
  const groups = MACHINE_PATH.exec(pathname)?.groups;
  const methods = groups?.last === undefined ? undefined : PATHS[groups.last];
  if (groups?.name === undefined || methods === undefined) return undefined;
  const action = Object.hasOwn(methods, method) ? methods[method] : undefined;
  const allow = Object.keys(methods).join(", ");
  try {
    return { name: decodeURIComponent(groups.name), action, allow };
  } catch {
    return { name: undefined, action, allow };
  }
};

/**
 * A request the hub has admitted: one that only a machine's spoke can answer, or one that saves
 * or forgets the hub's Cloudflare login.
 */
export type Ask =
  | { readonly ask: Action; readonly machine: Machine }
  | {
      readonly ask: "connect";
      readonly token: string;
      readonly account: Option.Option<string>;
      readonly zone: Option.Option<string>;
    }
  | { readonly ask: "disconnect" };

export const CLOUDFLARE_PATH = "/api/cloudflare";

/** Room for the longest token devbox takes, an account id and a domain. */
export const MAX_CLOUDFLARE_BYTES = 2048;

const Connect = Schema.fromJsonString(
  Schema.Struct({
    token: ApiToken,
    account: Schema.optional(Schema.String),
    zone: Schema.optional(Schema.String),
  }),
);

/**
 * `PUT /api/cloudflare` saves an API token as the hub's Cloudflare login and `DELETE` forgets
 * it. The caller is already logged in. The reply when the request is not one of those, or what
 * to ask.
 */
export const cloudflareAsk = (request: HubRequest): Reply | Ask => {
  if (request.method === "DELETE") return { ask: "disconnect" };
  if (request.method !== "PUT") return refuse(405, "Use PUT or DELETE.", { allow: "PUT, DELETE" });
  if (request.body === null)
    return refuse(413, "A Cloudflare API token is not that long.", { connection: "close" });
  const sent = Schema.decodeUnknownOption(Connect)(request.body, { onExcessProperty: "error" });
  if (Option.isNone(sent))
    return refuse(
      400,
      'Send {"token": "<Cloudflare API token>"}, with "account" and "zone" when the token sees more than one.',
    );
  const { token, account, zone } = sent.value;
  return {
    ask: "connect",
    token,
    account: Option.fromUndefinedOr(account),
    zone: Option.fromUndefinedOr(zone),
  };
};

const pickSentence = ({ what, choices, named }: PickOne) => {
  if (named !== undefined) return `The token sees no ${what} ${named}.`;
  if (choices.length === 0)
    return `The token sees no ${what}. Give it access to the ${what} that holds your domain.`;
  return `The token sees ${choices.length} ${what}s. Name one as "${what}".`;
};

const connect = (asked: Extract<Ask, { ask: "connect" }>, home: string) =>
  saveToken(home, asked.token, asked).pipe(
    Effect.map(({ zone }) => json(200, { zone, kind: "token" })),
    Effect.catchTags({
      PickOne: (pick) =>
        Effect.succeed(
          json(409, {
            error: pickSentence(pick),
            [pick.what === "account" ? "accounts" : "zones"]: pick.choices,
          }),
        ),
      CloudflareFailed: (error) => Effect.succeed(refuse(502, error.message)),
    }),
  );

const NO_CONTENT: Reply = { status: 204, headers: { "cache-control": "no-store" }, body: "" };

const disconnect = (home: string) =>
  forgetCloudflare(home).pipe(
    Effect.as(NO_CONTENT),
    Effect.catchTag("CloudflareFailed", () =>
      Effect.succeed(refuse(500, "The hub could not delete its Cloudflare login.")),
    ),
  );

const TUNNELS: ReadonlySet<Action> = new Set(["tunnel", "untunnel"]);

/**
 * The one step every request for a machine passes: the caller is logged in, the machine exists,
 * and its spoke trusts this hub. A tunnel also needs a Cloudflare login and the machine's
 * Tailscale address. The reply when it does not, or what to ask.
 */
export const admit = (
  request: HubRequest,
  wanted: { readonly name: string | undefined; readonly action: Action },
  snapshot: Snapshot & { readonly cloudflare: { readonly zone: string } | null },
  token: string,
  now: number,
): Reply | Ask => {
  if (!loggedIn(request, token, now)) return LOGGED_OUT;
  const named = snapshot.machines.filter((m) => m.name === wanted.name);
  if (named.length === 0) return refuse(404, "No machine has that name.");
  const trusted = named.filter((m) => m.spoke === "trusted");
  if (trusted.length !== 1 || trusted[0] === undefined)
    return refuse(
      409,
      named.some((m) => m.spoke === "untrusted")
        ? `${wanted.name} does not trust this hub's key.`
        : `${wanted.name} has no devbox spoke that answers.`,
    );
  const [machine] = trusted;
  if (TUNNELS.has(wanted.action)) {
    if (snapshot.cloudflare === null) return NO_LOGIN;
    if (machine.tailscale === null || machine.tailscale.ip === "")
      return refuse(409, `${machine.name} has no Tailscale address for a tunnel to reach.`);
  }
  return { ask: wanted.action, machine };
};

/** Runs what an admitted request asks for. */
export const answer = (asked: Ask, context: AskContext) => {
  switch (asked.ask) {
    case "connect":
      return connect(asked, context.home);
    case "disconnect":
      return disconnect(context.home);
    default:
      return ACTIONS[asked.ask](asked.machine, context);
  }
};

const Challenge = Schema.fromJsonString(Schema.Struct({ nonce: Nonce }));

const tellSpoke = (
  machine: Machine,
  action: Do,
  fields: Fields,
  secrets: HubSecrets,
  spokePort: number,
  timeoutMs: number,
) =>
  Effect.gen(function* () {
    const host = yield* Host;
    for (const address of spokeAddresses(machine)) {
      const spoke = origin(address, spokePort);
      const challenge = Option.flatMap(
        yield* host.fetchText(`${spoke}/api/challenge`, 2000),
        ({ body }) => Schema.decodeUnknownOption(Challenge)(body),
      );
      if (Option.isNone(challenge)) continue;
      const signed = signRequest(
        secrets.privateKey,
        new Date(),
        challenge.value.nonce,
        action,
        fields,
      );
      const answered = yield* host.post(
        `${spoke}/api/do`,
        { body: signed.body, contentType: "application/json", headers: signed.headers },
        timeoutMs,
      );
      if (Option.isSome(answered)) return answered;
    }
    return Option.none<string>();
  });
