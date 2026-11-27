import { Schema } from "effect";
import { constUndefined } from "effect/Function";

import type { Answer, Request } from "../../src/machine/host.ts";

const API = "https://api.cloudflare.com/client/v4";

export const CLOUDFLARE_TOKEN = "made-up-cloudflare-token-0123456789abcdef";
export const OAUTH_ACCESS = "made-up-oauth-access-token-0123456789";
export const OAUTH_REFRESH = "made-up-oauth-refresh-token-0123456789";
export const TUNNEL_TOKEN = `made-up-tunnel-token-${Buffer.from(JSON.stringify({ a: "1234567890" })).toString("base64")}`;

export const ACCOUNT = {
  id: "acc0000000000000000000000000001",
  name: "Owner's account",
};

export const ZONE = {
  id: "zone000000000000000000000000001",
  name: "example.com",
};

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

const NewRule = Schema.Struct({
  ref: Schema.String,
  expression: Schema.String,
  action: Schema.String,
  description: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
});

type Rule = typeof NewRule.Type & { id: string };

const NewRuleset = Schema.Struct({
  rules: Schema.optional(Schema.Array(NewRule)),
});

const NewTunnel = Schema.Struct({
  name: Schema.String,
  config_src: Schema.optional(Schema.String),
});

const NewIngress = Schema.Struct({ config: Schema.Json });

const NewRecord = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  content: Schema.String,
  comment: Schema.optional(Schema.String),
  proxied: Schema.optional(Schema.Boolean),
});

const RecordEdit = Schema.Struct({
  type: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  proxied: Schema.optional(Schema.Boolean),
});

interface Tunnel extends Schema.JsonObject {
  id: string;
  name: string;
  config_src: string;
  deleted: boolean;
  connections: number;
}

interface DnsRecord extends Schema.JsonObject {
  id: string;
  type: string;
  name: string;
  content: string;
  comment: string | null;
  proxied: boolean;
}

export interface FakeCloudflare {
  /** The one bearer it takes. */
  bearer: string;
  accounts: { id: string; name: string }[];
  zones: { id: string; name: string; account: string }[];
  /** The zone's custom ruleset, absent until one is made. */
  ruleset?: { id: string; rules: Rule[] };
  tunnels: Tunnel[];
  ingress: Map<string, unknown>;
  records: DnsRecord[];
  calls: Call[];
  /** A call answered as Cloudflare refusing it, with the message, before it changes anything. */
  refuse: (call: Call) => string | undefined;
  /** An answer in place of Cloudflare's own, such as one that is not JSON. */
  override: (call: Call) => Answer | undefined;
  /** For each DNS record made, whether the WAF rule for its name existed then. */
  guarded: boolean[];
  answer: (url: string, request: Request) => Answer | undefined;
}

const ok = (result: Schema.Json, status = 200) =>
  ({
    status,
    body: JSON.stringify({ success: true, errors: [], messages: [], result }),
  }) satisfies Answer;

const no = (status: number, message: string) =>
  ({
    status,
    body: JSON.stringify({
      success: false,
      errors: [{ code: 1000, message }],
      result: null,
    }),
  }) satisfies Answer;

let ids = 0;

const nextId = (prefix: string) => {
  ids += 1;

  return `${prefix}${String(ids).padStart(8, "0")}`;
};

export const makeCloudflare = (overrides: Partial<FakeCloudflare> = {}) => {
  const cf: FakeCloudflare = {
    bearer: CLOUDFLARE_TOKEN,
    accounts: [ACCOUNT],
    zones: [{ ...ZONE, account: ACCOUNT.id }],
    tunnels: [],
    ingress: new Map(),
    records: [],
    calls: [],
    refuse: constUndefined,
    override: constUndefined,
    guarded: [],
    answer: constUndefined,
    ...overrides,
  };

  const rulesets = (call: Call, parts: readonly string[]) => {
    const { method, body } = call;

    if (method === "GET" && parts[3] === "phases") {
      return cf.ruleset === undefined
        ? no(
            404,
            "could not find entrypoint ruleset in the http_request_firewall_custom phase"
          )
        : ok({ ...cf.ruleset, phase: "http_request_firewall_custom" });
    }

    if (method === "POST" && parts.length === 3) {
      const { rules = [] } = Schema.decodeUnknownSync(NewRuleset)(body);

      cf.ruleset = {
        id: nextId("rs"),
        rules: rules.map((r) => ({ ...r, id: nextId("rule") })),
      };

      return ok(cf.ruleset);
    }

    if (cf.ruleset === undefined || parts[3] !== cf.ruleset.id) {
      return no(404, "no ruleset");
    }

    if (method === "POST" && parts[4] === "rules") {
      cf.ruleset.rules.push({
        ...Schema.decodeUnknownSync(NewRule)(body),
        id: nextId("rule"),
      });

      return ok(cf.ruleset);
    }

    if (method === "DELETE" && parts[4] === "rules") {
      cf.ruleset.rules = cf.ruleset.rules.filter((r) => r.id !== parts[5]);

      return ok(cf.ruleset);
    }
  };

  const tunnels = (call: Call, parts: readonly string[]) => {
    const { method, query, body } = call;
    const live = cf.tunnels.filter((t) => !t.deleted);
    const tunnel = live.find((t) => t.id === parts[3]);

    if (method === "GET" && parts.length === 3) {
      return ok(
        live.filter((t) => query.name === undefined || t.name === query.name)
      );
    }

    if (method === "POST" && parts.length === 3) {
      const input = Schema.decodeUnknownSync(NewTunnel)(body);

      const made = {
        id: nextId("tun"),
        name: input.name,
        config_src: input.config_src ?? "local",
        deleted: false,
        connections: 0,
      };

      cf.tunnels.push(made);

      return ok(made);
    }

    if (tunnel === undefined) {
      return no(404, "Tunnel not found");
    }

    if (method === "PUT" && parts[4] === "configurations") {
      const { config } = Schema.decodeUnknownSync(NewIngress)(body);
      cf.ingress.set(tunnel.id, config);

      return ok({ tunnel_id: tunnel.id, config });
    }

    if (method === "GET" && parts[4] === "token") {
      return ok(TUNNEL_TOKEN);
    }

    if (method === "DELETE" && parts[4] === "connections") {
      tunnel.connections = 0;

      return ok(null);
    }

    if (method === "DELETE" && parts.length === 4) {
      if (tunnel.connections > 0) {
        return no(400, "Cannot delete a tunnel with active connections");
      }

      tunnel.deleted = true;

      return ok(tunnel);
    }
  };

  const dnsRecords = (call: Call, parts: readonly string[]) => {
    const { method, query, body } = call;
    const record = cf.records.find((r) => r.id === parts[3]);

    if (method === "GET" && parts.length === 3) {
      return ok(cf.records.filter((r) => r.name === query["name.exact"]));
    }

    if (method === "POST" && parts.length === 3) {
      const input = Schema.decodeUnknownSync(NewRecord)(body);
      cf.guarded.push(
        (cf.ruleset?.rules ?? []).some((r) =>
          r.expression.includes(`"${input.name}"`)
        )
      );

      const made: DnsRecord = {
        id: nextId("rec"),
        type: input.type,
        name: input.name,
        content: input.content,
        comment: input.comment ?? null,
        proxied: input.proxied === true,
      };

      cf.records.push(made);

      return ok(made);
    }

    if (record === undefined) {
      return no(404, "Record does not exist.");
    }

    if (method === "PATCH") {
      Object.assign(record, Schema.decodeUnknownSync(RecordEdit)(body));

      return ok(record);
    }

    if (method === "DELETE") {
      cf.records = cf.records.filter((r) => r.id !== record.id);

      return ok({ id: record.id });
    }
  };

  const routes = [
    { under: "zones", kind: "rulesets", handle: rulesets },
    { under: "accounts", kind: "cfd_tunnel", handle: tunnels },
    { under: "zones", kind: "dns_records", handle: dnsRecords },
  ];

  const handle = (call: Call) => {
    const { method, path, query } = call;
    const parts = path.split("/").filter((p) => p !== "");

    if (method === "GET" && path === "/user/tokens/verify") {
      return ok({ id: "tok", status: "active" });
    }

    if (method === "GET" && path === "/accounts") {
      return ok(cf.accounts);
    }

    if (method === "GET" && path === "/zones") {
      return ok(
        cf.zones
          .filter((z) => z.account === query["account.id"])
          .map(({ id, name, account }) => ({
            id,
            name,
            account: { id: account },
          }))
      );
    }

    const route = routes.find(
      ({ under, kind }) => parts[0] === under && parts[2] === kind
    );

    return (
      route?.handle(call, parts) ??
      no(404, `fake Cloudflare: no ${method} ${path}`)
    );
  };

  cf.answer = (url, request) => {
    if (!url.startsWith(`${API}/`)) {
      return;
    }

    const parsed = new URL(url);

    const call: Call = {
      method: request.method,
      path: parsed.pathname.slice("/client/v4".length),
      query: Object.fromEntries(parsed.searchParams),
      body:
        request.body === undefined
          ? undefined
          : Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
              request.body
            ),
    };

    cf.calls.push(call);

    if (request.headers?.authorization !== `Bearer ${cf.bearer}`) {
      return no(400, "Invalid request headers");
    }

    const replaced = cf.override(call);

    if (replaced !== undefined) {
      return replaced;
    }

    const refused = cf.refuse(call);

    if (refused !== undefined) {
      return no(400, refused);
    }

    return handle(call);
  };

  return cf;
};

/** What is left in Cloudflare, without ids, for comparing two runs. */
export const stateOf = (cf: FakeCloudflare) => ({
  rules: (cf.ruleset?.rules ?? []).map(({ ref, expression, action }) => ({
    ref,
    expression,
    action,
  })),
  tunnels: cf.tunnels
    .filter((t) => !t.deleted)
    .map(({ name, config_src }) => ({ name, config_src })),
  ingress: [...cf.ingress.entries()].flatMap(([id, config]) =>
    cf.tunnels.some((t) => t.id === id && !t.deleted) ? [config] : []
  ),
  records: cf.records.map(({ type, name, comment, proxied, content }) => ({
    type,
    name,
    comment,
    proxied,
    pointsAtTunnel: cf.tunnels.some(
      (t) => !t.deleted && content === `${t.id}.cfargotunnel.com`
    ),
  })),
});
