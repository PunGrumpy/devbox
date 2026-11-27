import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { bearerOf, saveCloudflare } from "../src/hub/cloudflare-auth.ts";
import { cloudflareApi } from "../src/hub/cloudflare.ts";
import type { Reply } from "../src/hub/login.ts";
import {
  expressionFor,
  hostnameOf,
  loadTunnels,
  publish,
  RECORD_COMMENT,
  StepFailed,
  type TunnelJob,
  tunnelsFile,
  unpublish,
} from "../src/hub/tunnel.ts";
import type { Fields } from "../src/spoke/signed.ts";
import {
  ACCOUNT,
  type Call,
  CLOUDFLARE_TOKEN,
  type FakeCloudflare,
  makeCloudflare,
  stateOf,
  TUNNEL_TOKEN,
  ZONE,
} from "./support/cloudflare.ts";
import { type FakeMachine, makeMachine } from "./support/host.ts";
import { runWith } from "./support/run.ts";

const HOSTNAME = "t3-edge-7.example.com";

type Spoke = {
  took: boolean;
  told: Array<{ readonly action: string; readonly fields: Fields }>;
};

const setUp = async (cf: FakeCloudflare = makeCloudflare()) => {
  const m = makeMachine();
  m.answer = (url, request) => cf.answer(url, request);
  await runWith(
    m.host,
    saveCloudflare(m.home, {
      login: { kind: "token", token: CLOUDFLARE_TOKEN },
      accountId: ACCOUNT.id,
      zoneId: ZONE.id,
      zone: ZONE.name,
    }),
  );
  const spoke: Spoke = { took: true, told: [] };
  return { m, cf, spoke };
};

const jobFor = (
  m: FakeMachine,
  spoke: Spoke,
  name = "edge-7",
  others: ReadonlyArray<string> = [],
): TunnelJob => ({
  home: m.home,
  others,
  machine: {
    name,
    tailscale: {
      ip: "100.64.0.22",
      dns: `${name}.tail1234.ts.net`,
      os: "linux",
      online: true,
      lastSeen: null,
    },
  },
  t3Port: 3773,
  cloudflare: (account) =>
    Effect.map(
      bearerOf(m.home, account).pipe(
        Effect.mapError((e) => new StepFailed({ step: "sign in to Cloudflare", said: e.message })),
      ),
      cloudflareApi,
    ),
  tell: (action, fields) =>
    Effect.sync(() => {
      spoke.told.push({ action, fields });
      return spoke.took;
    }),
});

const publishing = async (
  m: FakeMachine,
  spoke: Spoke,
  name?: string,
  others?: ReadonlyArray<string>,
) => (await runWith(m.host, publish(jobFor(m, spoke, name, others)))).value;
const unpublishing = async (m: FakeMachine, spoke: Spoke, name?: string) =>
  (await runWith(m.host, unpublish(jobFor(m, spoke, name)))).value;
const made = async (m: FakeMachine) => (await runWith(m.host, loadTunnels(m.home))).value;

const bodyOf = (reply: Reply) => JSON.parse(String(reply.body)) as Record<string, string>;

const RULE_MADE = (c: Call) =>
  c.method === "POST" && (c.path.endsWith("/rulesets") || c.path.endsWith("/rules"));
const RECORD_MADE = (c: Call) => c.method === "POST" && c.path.endsWith("/dns_records");

const PUBLISHED = {
  rules: [{ ref: "devbox-t3-edge-7", expression: expressionFor(HOSTNAME), action: "block" }],
  tunnels: [{ name: "devbox-edge-7", config_src: "cloudflare" }],
  ingress: [
    {
      ingress: [
        { hostname: HOSTNAME, service: "http://100.64.0.22:3773" },
        { service: "http_status:404" },
      ],
    },
  ],
  records: [
    {
      type: "CNAME",
      name: HOSTNAME,
      comment: RECORD_COMMENT,
      proxied: true,
      pointsAtTunnel: true,
    },
  ],
};

describe("the hostname", () => {
  test("is t3-<slug> in the zone, the slug the name in lower case with anything else a dash", () => {
    expect(hostnameOf("edge-7", "example.com")).toBe(HOSTNAME);
    expect(hostnameOf("Edge.7", "example.com")).toBe(HOSTNAME);
    expect(hostnameOf("evil.com/x", "example.com")).toBe("t3-evil-com-x.example.com");
  });

  test("the WAF expression is the README's, in lower case", () => {
    expect(expressionFor(HOSTNAME)).toBe(
      `(http.host eq "${HOSTNAME}" and (starts_with(lower(http.request.uri.path), "/mcp") or starts_with(lower(http.request.uri.path), "/oauth/mcp")))`,
    );
  });
});

describe("publishing", () => {
  test("makes the rule, the tunnel, its ingress and the record, then hands the token to the spoke", async () => {
    const { m, cf, spoke } = await setUp();
    const reply = await publishing(m, spoke);
    expect(reply.status).toBe(202);
    expect(bodyOf(reply)).toEqual({ url: `https://${HOSTNAME}` });
    expect(stateOf(cf)).toEqual(PUBLISHED);
    expect(spoke.told).toEqual([
      { action: "tunnel", fields: { token: TUNNEL_TOKEN, url: `https://${HOSTNAME}` } },
    ]);
    expect(await made(m)).toEqual({
      "edge-7": {
        hostname: HOSTNAME,
        accountId: ACCOUNT.id,
        zoneId: ZONE.id,
        published: true,
      },
    });
  });

  test("twice leaves one rule, one tunnel and one record", async () => {
    const { m, cf, spoke } = await setUp();
    expect((await publishing(m, spoke)).status).toBe(202);
    expect((await publishing(m, spoke)).status).toBe(202);
    expect(stateOf(cf)).toEqual(PUBLISHED);
  });

  test("the WAF rule is made before the DNS record", async () => {
    const { m, cf, spoke } = await setUp();
    await publishing(m, spoke);
    const rule = cf.calls.findIndex(RULE_MADE);
    const record = cf.calls.findIndex(RECORD_MADE);
    expect(rule).toBeGreaterThanOrEqual(0);
    expect(record).toBeGreaterThan(rule);
    expect(cf.guarded).toEqual([true]);
  });

  test("into a zone that already has custom rules, adds one and leaves the others", async () => {
    const theirs = {
      id: "rule-theirs",
      ref: "rule-theirs",
      expression: 'http.host eq "www.example.com"',
      action: "block",
      description: "the owner's",
    };
    const { m, cf, spoke } = await setUp(
      makeCloudflare({ ruleset: { id: "rs-theirs", rules: [theirs] } }),
    );
    await publishing(m, spoke);
    await unpublishing(m, spoke);
    expect(cf.ruleset?.rules).toEqual([theirs]);
  });

  const STEPS: ReadonlyArray<readonly [string, (c: Call) => boolean]> = [
    ["check the hostname", (c) => c.method === "GET" && c.path.endsWith("/dns_records")],
    ["add the WAF rule", (c) => c.path.includes("/rulesets")],
    ["create the tunnel", (c) => c.method === "POST" && c.path.endsWith("/cfd_tunnel")],
    ["route the tunnel", (c) => c.path.endsWith("/configurations")],
    ["point DNS at the tunnel", RECORD_MADE],
    ["get the tunnel token", (c) => c.path.endsWith("/token")],
  ];

  for (const [step, refused] of STEPS)
    test(`stopped where Cloudflare refuses to ${step}, and finished by asking again`, async () => {
      const { m, cf, spoke } = await setUp();
      cf.refuse = (c) => (refused(c) ? `no, said Cloudflare (${CLOUDFLARE_TOKEN})` : undefined);
      const stopped = await publishing(m, spoke);
      expect(stopped.status).toBe(502);
      expect(bodyOf(stopped)).toEqual({
        error: `Publishing edge-7 stopped when devbox tried to ${step}: no, said Cloudflare (<token>)`,
        step,
      });
      expect(String(stopped.body)).not.toContain(CLOUDFLARE_TOKEN);
      expect(String(stopped.body)).not.toContain(TUNNEL_TOKEN);
      expect(spoke.told).toEqual([]);
      expect(cf.guarded.every(Boolean)).toBe(true);
      cf.refuse = () => undefined;
      expect((await publishing(m, spoke)).status).toBe(202);
      expect(stateOf(cf)).toEqual(PUBLISHED);
      expect(cf.guarded).toEqual([true]);
    });

  test("stopped where the spoke does not take the token, and finished by asking again", async () => {
    const { m, cf, spoke } = await setUp();
    spoke.took = false;
    const stopped = await publishing(m, spoke);
    expect(stopped.status).toBe(502);
    expect(bodyOf(stopped)).toEqual({
      error:
        "Publishing edge-7 stopped when devbox tried to hand the tunnel to the machine: edge-7 did not take it",
      step: "hand the tunnel to the machine",
    });
    expect(String(stopped.body)).not.toContain(TUNNEL_TOKEN);
    expect(await made(m)).toMatchObject({
      "edge-7": { published: false },
    });
    spoke.took = true;
    expect((await publishing(m, spoke)).status).toBe(202);
    expect(stateOf(cf)).toEqual(PUBLISHED);
  });

  test("an answer that is not Cloudflare's JSON, or too large to read: 502 that says so", async () => {
    const { m, cf, spoke } = await setUp();
    cf.override = (c) =>
      c.path.endsWith("/cfd_tunnel") ? { status: 200, body: "<html>oops</html>" } : undefined;
    const html = bodyOf(await publishing(m, spoke));
    expect(html.error).toBe(
      "Publishing edge-7 stopped when devbox tried to create the tunnel: Cloudflare answered 200 with something that is not its JSON",
    );
    const answer = m.answer;
    m.answer = (url, request) =>
      url.includes("/configurations") ? undefined : answer(url, request);
    cf.override = () => undefined;
    const lost = bodyOf(await publishing(m, spoke));
    expect(lost.error).toBe(
      "Publishing edge-7 stopped when devbox tried to route the tunnel: Cloudflare did not answer, or its answer was too large",
    );
  });

  test("a hostname that already has a DNS record devbox did not make: 409, and nothing is made", async () => {
    const theirs = {
      id: "rec-theirs",
      type: "A",
      name: HOSTNAME,
      content: "192.0.2.1",
      comment: null,
      proxied: false,
    };
    const { m, cf, spoke } = await setUp(makeCloudflare({ records: [{ ...theirs }] }));
    const reply = await publishing(m, spoke);
    expect(reply.status).toBe(409);
    expect(bodyOf(reply).error).toBe(
      `${HOSTNAME} already has a DNS record that devbox did not make.`,
    );
    expect(cf.records).toEqual([theirs]);
    expect(cf.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect((await unpublishing(m, spoke)).status).toBe(204);
    expect(cf.records).toEqual([theirs]);
  });

  test("a CNAME the owner made for the hostname is not taken over", async () => {
    const theirs = {
      id: "rec-theirs",
      type: "CNAME",
      name: HOSTNAME,
      content: "elsewhere.example.net",
      comment: "mine",
      proxied: true,
    };
    const { m, cf, spoke } = await setUp(makeCloudflare({ records: [{ ...theirs }] }));
    expect((await publishing(m, spoke)).status).toBe(409);
    expect(cf.records).toEqual([theirs]);
  });

  test("a tunnel of the same name that is managed locally is not devbox's, and is left alone", async () => {
    const { m, cf, spoke } = await setUp(
      makeCloudflare({
        tunnels: [
          {
            id: "tun-theirs",
            name: "devbox-edge-7",
            config_src: "local",
            deleted: false,
            connections: 1,
          },
        ],
      }),
    );
    expect((await publishing(m, spoke)).status).toBe(202);
    expect((await unpublishing(m, spoke)).status).toBe(204);
    expect(cf.tunnels.find((t) => t.id === "tun-theirs")).toMatchObject({ deleted: false });
    expect(cf.ingress.has("tun-theirs")).toBe(false);
  });

  test("a name that makes no hostname in the zone: 409, and Cloudflare is not asked", async () => {
    const { m, cf, spoke } = await setUp();
    for (const name of ["edge_", "x".repeat(61), "-"]) {
      const reply = await publishing(m, spoke, name);
      expect(reply.status).toBe(409);
      expect(bodyOf(reply).error).toBe(
        `devbox cannot make a hostname in example.com from the name ${name}.`,
      );
    }
    expect(cf.calls).toEqual([]);
  });

  test("two names that make the same hostname: the second is refused", async () => {
    const { m, cf, spoke } = await setUp();
    expect((await publishing(m, spoke, "edge-7")).status).toBe(202);
    const reply = await publishing(m, spoke, "Edge.7");
    expect(reply.status).toBe(409);
    expect(bodyOf(reply).error).toBe(
      `Edge.7 and edge-7 would share ${HOSTNAME}. Rename one of them.`,
    );
    expect(stateOf(cf)).toEqual(PUBLISHED);
  });

  test("a name that makes the hostname of another machine the hub knows: 409, even before either is published", async () => {
    const { m, cf, spoke } = await setUp();
    const reply = await publishing(m, spoke, "Edge.7", ["edge-7", "edge-8"]);
    expect(reply.status).toBe(409);
    expect(bodyOf(reply).error).toBe(
      `Edge.7 and edge-7 would share ${HOSTNAME}. Rename one of them.`,
    );
    expect(cf.calls).toEqual([]);
  });

  test("without a saved login: 409", async () => {
    const m = makeMachine();
    const reply = await publishing(m, { took: true, told: [] });
    expect(reply.status).toBe(409);
  });
});

describe("unpublishing", () => {
  test("the spoke stops the tunnel, then the record, the tunnel and the rule go, in that order", async () => {
    const { m, cf, spoke } = await setUp();
    await publishing(m, spoke);
    const from = cf.calls.length;
    const reply = await unpublishing(m, spoke);
    expect(reply.status).toBe(204);
    expect(spoke.told.at(-1)).toEqual({ action: "untunnel", fields: {} });
    const deletes = cf.calls
      .slice(from)
      .filter((c) => c.method === "DELETE")
      .map((c) => c.path.split("/")[3]);
    expect(deletes).toEqual(["dns_records", "cfd_tunnel", "cfd_tunnel", "rulesets"]);
    expect(stateOf(cf)).toEqual({ rules: [], tunnels: [], ingress: [], records: [] });
    expect(readFileSync(tunnelsFile(m.home), "utf8").trim()).toBe("{}");
  });

  test("when the spoke does not take it: 502, and nothing in Cloudflare is deleted", async () => {
    const { m, cf, spoke } = await setUp();
    await publishing(m, spoke);
    spoke.took = false;
    const reply = await unpublishing(m, spoke);
    expect(reply.status).toBe(502);
    expect(bodyOf(reply).step).toBe("take the tunnel from the machine");
    expect(stateOf(cf)).toEqual(PUBLISHED);
  });

  for (const [step, refused] of [
    [
      "delete the DNS record",
      (c: Call) => c.method === "DELETE" && c.path.includes("/dns_records/"),
    ],
    ["delete the tunnel", (c: Call) => c.method === "DELETE" && c.path.includes("/cfd_tunnel/")],
    ["delete the WAF rule", (c: Call) => c.method === "DELETE" && c.path.includes("/rules/")],
  ] as const)
    test(`stopped where Cloudflare refuses to ${step}, and finished by asking again`, async () => {
      const { m, cf, spoke } = await setUp();
      await publishing(m, spoke);
      cf.refuse = (c) => (refused(c) ? "no" : undefined);
      const stopped = await unpublishing(m, spoke);
      expect(stopped.status).toBe(502);
      expect(bodyOf(stopped).step).toBe(step);
      cf.refuse = () => undefined;
      expect((await unpublishing(m, spoke)).status).toBe(204);
      expect(stateOf(cf)).toEqual({ rules: [], tunnels: [], ingress: [], records: [] });
    });

  test("with nothing published: 204", async () => {
    const { m, cf, spoke } = await setUp();
    expect((await unpublishing(m, spoke)).status).toBe(204);
    expect(cf.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});
