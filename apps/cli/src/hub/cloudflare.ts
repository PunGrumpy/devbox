import { Effect, Option, Schema } from "effect";
import { Host } from "../machine/host.ts";
import { type CloudflareAccount, CloudflareFailed, saveCloudflare } from "./cloudflare-auth.ts";

const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 20_000;
const MAX_SAID = 300;

export type CloudflareRequest = {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Under /client/v4, starting with a slash. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
};

/** Cloudflare answered with an error, or did not answer at all (status null). */
export class CloudflareRefused extends Schema.TaggedError<CloudflareRefused>()(
  "CloudflareRefused",
  { status: Schema.NullOr(Schema.Number), said: Schema.String },
) {}

const Envelope = Schema.fromJsonString(
  Schema.Struct({
    success: Schema.Boolean,
    errors: Schema.optional(
      Schema.NullOr(Schema.Array(Schema.Struct({ message: Schema.optional(Schema.String) }))),
    ),
    result: Schema.optional(Schema.Unknown),
  }),
);

const quote = (text: string, bearer: string): string => {
  const plain = text.replaceAll(/\s+/g, " ").trim();
  const clean = bearer === "" ? plain : plain.replaceAll(bearer, "<token>");
  return clean.length > MAX_SAID ? `${clean.slice(0, MAX_SAID - 1)}…` : clean;
};

const urlOf = ({ path, query = {} }: CloudflareRequest): string => {
  const url = new URL(`${API}${path}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url.href;
};

/**
 * The one function every Cloudflare request goes through: the request, with the bearer, and the
 * `result` of a successful answer.
 */
export const call = (bearer: string, request: CloudflareRequest) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const answered = yield* host.request(
      urlOf(request),
      {
        method: request.method,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      },
      TIMEOUT_MS,
    );
    if (Option.isNone(answered))
      return yield* new CloudflareRefused({
        status: null,
        said: "Cloudflare did not answer, or its answer was too large",
      });
    const { status, body } = answered.value;
    const envelope = Schema.decodeUnknownOption(Envelope)(body);
    if (Option.isNone(envelope))
      return yield* new CloudflareRefused({
        status,
        said: `Cloudflare answered ${status} with something that is not its JSON`,
      });
    if (!envelope.value.success || status < 200 || status > 299) {
      const messages = (envelope.value.errors ?? []).flatMap((e) =>
        e.message === undefined ? [] : [e.message],
      );
      return yield* new CloudflareRefused({
        status,
        said: quote(messages.length === 0 ? `status ${status}` : messages.join("; "), bearer),
      });
    }
    return envelope.value.result;
  });

const read =
  <T, E>(schema: Schema.Codec<T, E>) =>
  (result: unknown) =>
    Option.match(Schema.decodeUnknownOption(schema)(result), {
      onNone: () =>
        Effect.fail(
          new CloudflareRefused({
            status: 200,
            said: "Cloudflare answered in a shape devbox does not know",
          }),
        ),
      onSome: (value: T) => Effect.succeed(value),
    });

const PER_PAGE = "50";

const Named = Schema.Struct({ id: Schema.String, name: Schema.String });
export type Named = typeof Named.Type;

const Verified = Schema.Struct({ status: Schema.String });

const Rule = Schema.Struct({
  id: Schema.String,
  ref: Schema.optional(Schema.String),
  expression: Schema.optional(Schema.String),
});
export type Rule = typeof Rule.Type;

const Ruleset = Schema.Struct({
  id: Schema.String,
  rules: Schema.optional(Schema.NullOr(Schema.Array(Rule))),
});
export type Ruleset = typeof Ruleset.Type;

const Tunnel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  config_src: Schema.optional(Schema.NullOr(Schema.String)),
});
export type Tunnel = typeof Tunnel.Type;

const DnsRecord = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  name: Schema.String,
  content: Schema.optional(Schema.NullOr(Schema.String)),
  comment: Schema.optional(Schema.NullOr(Schema.String)),
});
export type DnsRecord = typeof DnsRecord.Type;

export type NewRule = {
  readonly ref: string;
  readonly description: string;
  readonly expression: string;
};

const PHASE = "http_request_firewall_custom";

const tunnels = (accountId: string) => `/accounts/${accountId}/cfd_tunnel`;

/** The calls devbox makes, each with the bearer it was given. */
export const cloudflareApi = (bearer: string) => {
  const ask = (request: CloudflareRequest) => call(bearer, request);
  return {
    /** Whether the token is active, asked as a user token and then as one owned by the account. */
    verify: (accountId: string) =>
      ask({ method: "GET", path: "/user/tokens/verify" }).pipe(
        Effect.catch(() => ask({ method: "GET", path: `/accounts/${accountId}/tokens/verify` })),
        Effect.flatMap(read(Verified)),
      ),
    accounts: ask({ method: "GET", path: "/accounts", query: { per_page: PER_PAGE } }).pipe(
      Effect.flatMap(read(Schema.Array(Named))),
    ),
    zones: (accountId: string) =>
      ask({
        method: "GET",
        path: "/zones",
        query: { "account.id": accountId, per_page: PER_PAGE },
      }).pipe(Effect.flatMap(read(Schema.Array(Named)))),

    /** The zone's custom rules, or none when the zone has none yet. */
    firewall: (zoneId: string) =>
      ask({ method: "GET", path: `/zones/${zoneId}/rulesets/phases/${PHASE}/entrypoint` }).pipe(
        Effect.flatMap(read(Ruleset)),
        Effect.map(Option.some),
        Effect.catchIf(
          (error) => error._tag === "CloudflareRefused" && error.status === 404,
          () => Effect.succeed(Option.none<Ruleset>()),
        ),
      ),
    /** The zone's first custom rule, which makes the ruleset that holds them. */
    createFirewall: (zoneId: string, rule: NewRule) =>
      ask({
        method: "POST",
        path: `/zones/${zoneId}/rulesets`,
        body: {
          name: "default",
          kind: "zone",
          phase: PHASE,
          rules: [{ ...rule, action: "block", enabled: true }],
        },
      }).pipe(Effect.flatMap(read(Ruleset))),
    addRule: (zoneId: string, rulesetId: string, rule: NewRule) =>
      ask({
        method: "POST",
        path: `/zones/${zoneId}/rulesets/${rulesetId}/rules`,
        body: { ...rule, action: "block", enabled: true },
      }).pipe(Effect.flatMap(read(Ruleset))),
    deleteRule: (zoneId: string, rulesetId: string, ruleId: string) =>
      Effect.asVoid(
        ask({ method: "DELETE", path: `/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}` }),
      ),

    findTunnels: (accountId: string, name: string) =>
      ask({
        method: "GET",
        path: tunnels(accountId),
        query: { name, is_deleted: "false" },
      }).pipe(Effect.flatMap(read(Schema.Array(Tunnel)))),
    createTunnel: (accountId: string, name: string) =>
      ask({
        method: "POST",
        path: tunnels(accountId),
        body: { name, config_src: "cloudflare" },
      }).pipe(Effect.flatMap(read(Tunnel))),
    /** Drops the tunnel's connections first, since Cloudflare deletes no tunnel that has one. */
    deleteTunnel: (accountId: string, tunnelId: string) =>
      Effect.asVoid(
        ask({ method: "DELETE", path: `${tunnels(accountId)}/${tunnelId}/connections` }).pipe(
          Effect.andThen(ask({ method: "DELETE", path: `${tunnels(accountId)}/${tunnelId}` })),
        ),
      ),
    /** Sends what reaches `hostname` to `service`, and answers 404 to anything else. */
    putIngress: (accountId: string, tunnelId: string, hostname: string, service: string) =>
      Effect.asVoid(
        ask({
          method: "PUT",
          path: `${tunnels(accountId)}/${tunnelId}/configurations`,
          body: { config: { ingress: [{ hostname, service }, { service: "http_status:404" }] } },
        }),
      ),
    tunnelToken: (accountId: string, tunnelId: string) =>
      ask({ method: "GET", path: `${tunnels(accountId)}/${tunnelId}/token` }).pipe(
        Effect.flatMap(read(Schema.String)),
      ),

    findRecords: (zoneId: string, hostname: string) =>
      ask({
        method: "GET",
        path: `/zones/${zoneId}/dns_records`,
        query: { "name.exact": hostname, per_page: PER_PAGE },
      }).pipe(Effect.flatMap(read(Schema.Array(DnsRecord)))),
    createRecord: (zoneId: string, record: { name: string; content: string; comment: string }) =>
      ask({
        method: "POST",
        path: `/zones/${zoneId}/dns_records`,
        body: { ...record, type: "CNAME", proxied: true, ttl: 1 },
      }).pipe(Effect.flatMap(read(DnsRecord))),
    editRecord: (zoneId: string, recordId: string, content: string) =>
      ask({
        method: "PATCH",
        path: `/zones/${zoneId}/dns_records/${recordId}`,
        body: { type: "CNAME", content, proxied: true },
      }).pipe(Effect.flatMap(read(DnsRecord))),
    deleteRecord: (zoneId: string, recordId: string) =>
      Effect.asVoid(ask({ method: "DELETE", path: `/zones/${zoneId}/dns_records/${recordId}` })),
  };
};

export type CloudflareApi = ReturnType<typeof cloudflareApi>;

/** A refusal as an error a command prints, which says what Cloudflare said. */
export const failed = (doing: string) => (error: CloudflareRefused) =>
  new CloudflareFailed({ message: `Cloudflare refused to ${doing}: ${error.said}` });

/** One Cloudflare API token: printable ASCII, no spaces, at most 1024 characters. */
export const ApiToken = Schema.String.pipe(Schema.check(Schema.isPattern(/^[\x21-\x7e]{1,1024}$/)));

/**
 * The token does not settle which account or zone to use: it sees none, it sees several and none
 * was named, or it does not see the one named. `choices` is what it sees.
 */
export class PickOne extends Schema.TaggedError<PickOne>()("PickOne", {
  what: Schema.Literals(["account", "zone"]),
  choices: Schema.Array(Named),
  named: Schema.optional(Schema.String),
}) {}

const choose = <A extends Named>(
  what: PickOne["what"],
  choices: ReadonlyArray<A>,
  wanted: Option.Option<string>,
  matches: (choice: A, wanted: string) => boolean,
) => {
  const named = Option.getOrUndefined(wanted);
  const only = choices.length === 1 ? choices[0] : undefined;
  const found = named === undefined ? only : choices.find((c) => matches(c, named));
  return found === undefined
    ? Effect.fail(
        new PickOne({ what, choices: choices.map(({ id, name }) => ({ id, name })), named }),
      )
    : Effect.succeed(found);
};

/** The account and zone a login works in: the ones `wanted` names, or the only ones it sees. */
export const placeOf = (
  api: CloudflareApi,
  wanted: { readonly account: Option.Option<string>; readonly zone: Option.Option<string> },
) =>
  Effect.gen(function* () {
    const accounts = yield* api.accounts.pipe(
      Effect.mapError(failed("list the accounts this token sees")),
    );
    const account = yield* choose("account", accounts, wanted.account, (a, id) => a.id === id);
    const zones = yield* api
      .zones(account.id)
      .pipe(Effect.mapError(failed("list the zones this token sees")));
    const zone = yield* choose(
      "zone",
      zones,
      wanted.zone,
      (z, name) => z.name.toLowerCase() === name.toLowerCase(),
    );
    return { accountId: account.id, zoneId: zone.id, zone: zone.name.toLowerCase() };
  });

/**
 * Checks an API token with Cloudflare, picks its account and zone, and saves it as the hub's
 * login in place of any before it. `devbox hub cloudflare token` and `PUT /api/cloudflare` both
 * come here.
 */
export const saveToken = (
  home: string,
  token: string,
  wanted: { readonly account: Option.Option<string>; readonly zone: Option.Option<string> },
) =>
  Effect.gen(function* () {
    const api = cloudflareApi(token);
    const place = yield* placeOf(api, wanted);
    const verified = yield* api
      .verify(place.accountId)
      .pipe(Effect.mapError(failed("verify the token")));
    if (verified.status !== "active")
      return yield* new CloudflareFailed({
        message: `Cloudflare says the token is ${verified.status}`,
        hint: "make a new one in the Cloudflare dashboard",
      });
    const account: CloudflareAccount = { login: { kind: "token", token }, ...place };
    yield* saveCloudflare(home, account);
    return account;
  });
