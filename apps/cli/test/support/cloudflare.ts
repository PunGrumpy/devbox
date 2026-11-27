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

interface Rule {
  id: string;
  ref: string;
  expression: string;
  action: string;
  description: string;
}

interface Tunnel {
  id: string;
  name: string;
  config_src: string;
  deleted: boolean;
  connections: number;
}

interface DnsRecord {
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
  /** The zone's custom ruleset, undefined until one is made. */
  ruleset: { id: string; rules: Rule[] } | undefined;
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

const ok = (result: unknown, status = 200): Answer => ({
  status,
  body: JSON.stringify({ success: true, errors: [], messages: [], result }),
});

const no = (status: number, message: string): Answer => ({
  status,
  body: JSON.stringify({
    success: false,
    errors: [{ code: 1000, message }],
    result: null,
  }),
});

let ids = 0;

const nextId = (prefix: string) =>
  `${prefix}${String((ids += 1)).padStart(8, "0")}`;

export const makeCloudflare = (
  overrides: Partial<FakeCloudflare> = {}
): FakeCloudflare => {
  const cf: FakeCloudflare = {
    bearer: CLOUDFLARE_TOKEN,
    accounts: [ACCOUNT],
    zones: [{ ...ZONE, account: ACCOUNT.id }],
    ruleset: undefined,
    tunnels: [],
    ingress: new Map(),
    records: [],
    calls: [],
    refuse: () => undefined,
    override: () => undefined,
    guarded: [],
    answer: () => undefined,
    ...overrides,
  };

  const handle = (call: Call): Answer => {
    const { method, path, query, body } = call;
    const input = (body ?? {}) as Record<string, unknown>;
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
          .map(({ id, name }) => ({
            id,
            name,
            account: { id: query["account.id"] },
          }))
      );
    }

    if (parts[0] === "zones" && parts[2] === "rulesets") {
      if (method === "GET" && parts[3] === "phases") {
        return cf.ruleset === undefined
          ? no(
              404,
              "could not find entrypoint ruleset in the http_request_firewall_custom phase"
            )
          : ok({ ...cf.ruleset, phase: "http_request_firewall_custom" });
      }

      if (method === "POST" && parts.length === 3) {
        cf.ruleset = {
          id: nextId("rs"),
          rules: ((input.rules ?? []) as Omit<Rule, "id">[]).map((r) => ({
            ...r,
            id: nextId("rule"),
          })),
        };

        return ok(cf.ruleset);
      }

      if (cf.ruleset === undefined || parts[3] !== cf.ruleset.id) {
        return no(404, "no ruleset");
      }

      if (method === "POST" && parts[4] === "rules") {
        cf.ruleset.rules.push({
          ...(input as Omit<Rule, "id">),
          id: nextId("rule"),
        });

        return ok(cf.ruleset);
      }

      if (method === "DELETE" && parts[4] === "rules") {
        cf.ruleset.rules = cf.ruleset.rules.filter((r) => r.id !== parts[5]);

        return ok(cf.ruleset);
      }
    }

    if (parts[0] === "accounts" && parts[2] === "cfd_tunnel") {
      const live = cf.tunnels.filter((t) => !t.deleted);
      const tunnel = live.find((t) => t.id === parts[3]);

      if (method === "GET" && parts.length === 3) {
        return ok(
          live.filter((t) => query.name === undefined || t.name === query.name)
        );
      }

      if (method === "POST" && parts.length === 3) {
        const made = {
          id: nextId("tun"),
          name: String(input.name),
          config_src: String(input.config_src ?? "local"),
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
        cf.ingress.set(tunnel.id, input.config);

        return ok({ tunnel_id: tunnel.id, config: input.config });
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
    }

    if (parts[0] === "zones" && parts[2] === "dns_records") {
      const record = cf.records.find((r) => r.id === parts[3]);

      if (method === "GET" && parts.length === 3) {
        return ok(cf.records.filter((r) => r.name === query["name.exact"]));
      }

      if (method === "POST" && parts.length === 3) {
        const name = String(input.name);
        cf.guarded.push(
          (cf.ruleset?.rules ?? []).some((r) =>
            r.expression.includes(`"${name}"`)
          )
        );

        const made: DnsRecord = {
          id: nextId("rec"),
          type: String(input.type),
          name,
          content: String(input.content),
          comment: typeof input.comment === "string" ? input.comment : null,
          proxied: input.proxied === true,
        };

        cf.records.push(made);

        return ok(made);
      }

      if (record === undefined) {
        return no(404, "Record does not exist.");
      }

      if (method === "PATCH") {
        Object.assign(record, input);

        return ok(record);
      }

      if (method === "DELETE") {
        cf.records = cf.records.filter((r) => r.id !== record.id);

        return ok({ id: record.id });
      }
    }

    return no(404, `fake Cloudflare: no ${method} ${path}`);
  };

  cf.answer = (url, request) => {
    if (!url.startsWith(`${API}/`)) {
      return undefined;
    }

    const parsed = new URL(url);

    const call: Call = {
      method: request.method,
      path: parsed.pathname.slice("/client/v4".length),
      query: Object.fromEntries(parsed.searchParams),
      body: request.body === undefined ? undefined : JSON.parse(request.body),
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
  ingress: [...cf.ingress.entries()]
    .filter(([id]) => cf.tunnels.some((t) => t.id === id && !t.deleted))
    .map(([, config]) => config),
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
