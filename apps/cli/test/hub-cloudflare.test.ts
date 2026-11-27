import { afterAll, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Layer, Option, Stdio, Stream } from "effect";
import { Command } from "effect/cli";
import { runCli } from "../src/cli.ts";
import { hintOf } from "../src/errors.ts";
import {
  bearerOf,
  type CloudflareAccount,
  cloudflareFile,
  saveCloudflare,
} from "../src/hub/cloudflare-auth.ts";
import { saveLogin } from "../src/hub/cloudflare-command.ts";
import {
  type Answer,
  CLOUDFLARE_FLOW,
  loginCommand,
  type PostForm,
} from "../src/hub/cloudflare-oauth.ts";
import {
  type HubMachine,
  type HubRequest,
  type HubSnapshot,
  type Reply,
  route,
} from "../src/hub/hub.ts";
import { tunnelsFile } from "../src/hub/tunnel.ts";
import { Host } from "../src/machine/host.ts";
import { freePort } from "../src/machine/proxy.ts";
import { Locations } from "../src/migrate/locations.ts";
import { T3Process } from "../src/migrate/t3-process.ts";
import { Output } from "../src/output.ts";
import { fingerprint, handOut, verifyRequest } from "../src/spoke/signed.ts";
import {
  ACCOUNT,
  CLOUDFLARE_TOKEN,
  type FakeCloudflare,
  makeCloudflare,
  OAUTH_ACCESS,
  OAUTH_REFRESH,
  stateOf,
  TUNNEL_TOKEN,
  ZONE,
} from "./support/cloudflare.ts";
import { type FakeMachine, makeMachine } from "./support/host.ts";
import { devbox, runWith, start } from "./support/run.ts";

const piped = async (m: FakeMachine, args: ReadonlyArray<string>, stdin: string) => {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const output = Output.make({
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    paint: (_, text) => text,
    stdoutColor: false,
    interactive: false,
    readAnswer: Effect.die("no terminal in tests"),
    pickMany: () => Effect.die("no terminal in tests"),
  });
  const stdio = Stdio.layerTest({
    stdin: Stream.make(new TextEncoder().encode(stdin)),
    stdinIsTerminal: Effect.succeed(false),
  });
  const code = await Effect.runPromise(
    runCli(args).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Output, output),
          Locations.layer,
          Layer.succeed(Host, m.host),
          Layer.succeed(T3Process, { running: Effect.succeed(Option.none()) }),
        ).pipe(
          Layer.provideMerge(Layer.merge(BunServices.layer, stdio)),
          Layer.provideMerge(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: m.home } })),
          ),
        ),
      ),
    ),
  );
  return { code, out: out.join(""), err: err.join("") };
};

const withCloudflare = (cf: FakeCloudflare = makeCloudflare()) => {
  const m = makeMachine();
  m.answer = (url, request) => cf.answer(url, request);
  return { m, cf };
};

const saveToken = (m: FakeMachine, flags: ReadonlyArray<string> = []) =>
  piped(m, ["hub", "cloudflare", "token", ...flags], `${CLOUDFLARE_TOKEN}\n`);

const CLIENT = "made-up-client-id";
const CODE = "made-up-code-0123456789";
const NEW_ACCESS = "made-up-oauth-access-token-renewed-9876";
const NEW_REFRESH = "made-up-oauth-refresh-token-renewed-9876";

const tokenAnswer = (access: string, refresh: string): Answer => ({
  status: 200,
  body: JSON.stringify({
    access_token: access,
    token_type: "bearer",
    expires_in: 3600,
    refresh_token: refresh,
  }),
});

const tokenEndpoint = (answer: Answer, delayMs = 0) => {
  const sent: Array<Readonly<Record<string, string>>> = [];
  const post: PostForm = (_, form) =>
    Effect.sync(() => sent.push(form)).pipe(
      Effect.andThen(Effect.sleep(delayMs)),
      Effect.as(answer),
    );
  return { post, sent };
};

const logIn = async (m: FakeMachine, flags: ReadonlyArray<string> = []) => {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const output = Output.make({
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    paint: (_, text) => text,
    stdoutColor: false,
    interactive: false,
    readAnswer: Effect.die("no terminal in tests"),
    pickMany: () => Effect.die("no terminal in tests"),
  });
  const port = await Effect.runPromise(freePort);
  const { post } = tokenEndpoint(tokenAnswer(OAUTH_ACCESS, OAUTH_REFRESH));
  const root = Command.make("devbox").pipe(
    Command.withSubcommands([
      loginCommand(saveLogin, { ...CLOUDFLARE_FLOW, port, waitMs: 10_000, post }),
    ]),
  );
  const done = Effect.runPromise(
    Command.runWith(root, { version: "0" })(["login", "--client-id", CLIENT, ...flags]).pipe(
      Effect.as(0),
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* (yield* Output).error(error.message, hintOf(error));
          return 1;
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Output, output),
          Locations.layer,
          Layer.succeed(Host, m.host),
        ).pipe(
          Layer.provideMerge(BunServices.layer),
          Layer.provideMerge(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: m.home } })),
          ),
        ),
      ),
    ),
  );
  let address: string | undefined;
  for (let tries = 0; tries < 200 && address === undefined; tries += 1) {
    address = /^ {2}(http\S+)$/m.exec(err.join(""))?.[1];
    if (address === undefined) await Bun.sleep(10);
  }
  const state = new URL(address ?? "http://127.0.0.1/").searchParams.get("state") ?? "";
  await fetch(`http://127.0.0.1:${port}/callback?code=${CODE}&state=${state}`);
  return { code: await done, out: out.join(""), err: err.join("") };
};

const savedFile = (m: FakeMachine) =>
  JSON.parse(readFileSync(cloudflareFile(m.home), "utf8")) as CloudflareAccount;

const oauthAccount = (expiresAt: number): CloudflareAccount => ({
  login: {
    kind: "oauth",
    clientId: CLIENT,
    accessToken: OAUTH_ACCESS,
    refreshToken: OAUTH_REFRESH,
    expiresAt: new Date(expiresAt).toISOString(),
  },
  accountId: ACCOUNT.id,
  zoneId: ZONE.id,
  zone: ZONE.name,
});

describe("devbox hub cloudflare", () => {
  test("token reads the token from stdin, checks it, and saves it for this user alone", async () => {
    const { m, cf } = withCloudflare();
    const saved = await saveToken(m);
    expect(saved.code).toBe(0);
    expect(saved.err).toContain("saved a Cloudflare API token for example.com");
    expect(statSync(cloudflareFile(m.home)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(cloudflareFile(m.home), "utf8"))).toEqual({
      login: { kind: "token", token: CLOUDFLARE_TOKEN },
      accountId: ACCOUNT.id,
      zoneId: ZONE.id,
      zone: "example.com",
    });
    expect(cf.calls.map((c) => c.path)).toContain("/user/tokens/verify");
    expect(`${saved.out}${saved.err}`).not.toContain(CLOUDFLARE_TOKEN);
  });

  test("status says the kind of login and the zone, and never the token", async () => {
    const { m } = withCloudflare();
    expect(
      (await devbox({ HOME: m.home }, ["hub", "cloudflare", "status"], { host: m.host })).out,
    ).toBe("No Cloudflare login is saved.\n");
    await saveToken(m);
    const status = await devbox({ HOME: m.home }, ["hub", "cloudflare", "status"], {
      host: m.host,
    });
    expect(status.code).toBe(0);
    expect(status.out).toBe(`Cloudflare: token, zone example.com, account ${ACCOUNT.id}.\n`);
    expect(`${status.out}${status.err}`).not.toContain(CLOUDFLARE_TOKEN);
  });

  test("status for an OAuth login says oauth, the client and the zone, and never a token", async () => {
    const m = makeMachine();
    const account = oauthAccount(Date.parse("2026-11-27T13:00:00.000Z"));
    await runWith(m.host, saveCloudflare(m.home, account));
    const status = await devbox({ HOME: m.home }, ["hub", "cloudflare", "status"], {
      host: m.host,
    });
    expect(status.code).toBe(0);
    expect(status.out).toBe(
      `Cloudflare: oauth with client ${CLIENT}, zone example.com, account ${ACCOUNT.id}, access until 2026-11-27T13:00:00.000Z.\n`,
    );
    for (const secret of [OAUTH_ACCESS, OAUTH_REFRESH])
      expect(`${status.out}${status.err}`).not.toContain(secret);
  });

  test("login signs in with OAuth and saves the account and zone Cloudflare offers", async () => {
    const { m, cf } = withCloudflare(makeCloudflare({ bearer: OAUTH_ACCESS }));
    const signedIn = await logIn(m);
    expect(signedIn.code).toBe(0);
    expect(signedIn.err).toContain("the hub is signed in to Cloudflare");
    expect(statSync(cloudflareFile(m.home)).mode & 0o777).toBe(0o600);
    expect(savedFile(m)).toEqual({
      login: {
        kind: "oauth",
        clientId: CLIENT,
        accessToken: OAUTH_ACCESS,
        refreshToken: OAUTH_REFRESH,
        expiresAt: expect.any(String),
      },
      accountId: ACCOUNT.id,
      zoneId: ZONE.id,
      zone: "example.com",
    });
    expect(cf.calls.map((c) => c.path)).toEqual(["/accounts", "/zones"]);
    for (const secret of [OAUTH_ACCESS, OAUTH_REFRESH, CODE])
      expect(`${signedIn.out}${signedIn.err}`).not.toContain(secret);
  });

  test("login with two accounts or two zones asks for the flag, and saves only once it has one", async () => {
    const other = { id: "acc0000000000000000000000000002", name: "Work" };
    const { m } = withCloudflare(
      makeCloudflare({
        bearer: OAUTH_ACCESS,
        accounts: [ACCOUNT, other],
        zones: [
          { ...ZONE, account: ACCOUNT.id },
          { id: "zone000000000000000000000000002", name: "example.org", account: ACCOUNT.id },
        ],
      }),
    );
    const accounts = await logIn(m);
    expect(accounts.code).toBe(1);
    expect(accounts.err).toContain("pass --account <id> to pick one");
    expect(existsSync(cloudflareFile(m.home))).toBe(false);
    const zones = await logIn(m, ["--account", ACCOUNT.id]);
    expect(zones.code).toBe(1);
    expect(zones.err).toContain("the token sees 2 zones: example.com, example.org");
    expect(zones.err).toContain("pass --zone <domain> to pick one");
    expect(existsSync(cloudflareFile(m.home))).toBe(false);
    const picked = await logIn(m, ["--account", ACCOUNT.id, "--zone", "Example.ORG"]);
    expect(picked.code).toBe(0);
    expect(savedFile(m)).toMatchObject({
      login: { kind: "oauth" },
      zone: "example.org",
      zoneId: "zone000000000000000000000000002",
    });
    for (const secret of [OAUTH_ACCESS, OAUTH_REFRESH, CODE])
      expect(`${accounts.err}${zones.err}${picked.err}`).not.toContain(secret);
  });

  test("logout deletes the file", async () => {
    const { m } = withCloudflare();
    await saveToken(m);
    const out = await devbox({ HOME: m.home }, ["hub", "cloudflare", "logout"], { host: m.host });
    expect(out.code).toBe(0);
    expect(existsSync(cloudflareFile(m.home))).toBe(false);
    const again = await devbox({ HOME: m.home }, ["hub", "cloudflare", "logout"], { host: m.host });
    expect(again.out).toBe("No Cloudflare login was saved.\n");
  });

  test("a token Cloudflare refuses is not saved, and the error quotes Cloudflare, never the token", async () => {
    const { m, cf } = withCloudflare();
    cf.refuse = () => `Invalid API Token ${CLOUDFLARE_TOKEN}`;
    const refused = await saveToken(m);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(
      "Cloudflare refused to list the accounts this token sees: Invalid API Token <token>",
    );
    expect(`${refused.out}${refused.err}`).not.toContain(CLOUDFLARE_TOKEN);
    expect(existsSync(cloudflareFile(m.home))).toBe(false);
  });

  test("the token comes from stdin only, never an argument", async () => {
    const { m } = withCloudflare();
    const argued = await piped(m, ["hub", "cloudflare", "token", CLOUDFLARE_TOKEN], "");
    expect(argued.code).not.toBe(0);
    expect(existsSync(cloudflareFile(m.home))).toBe(false);
    const empty = await piped(m, ["hub", "cloudflare", "token"], "\n");
    expect(empty.code).toBe(2);
    expect(empty.err).toContain("expected one Cloudflare API token on stdin");
  });

  test("with two accounts or two zones, it asks for the flag and names the choices", async () => {
    const other = { id: "acc0000000000000000000000000002", name: "Work" };
    const { m } = withCloudflare(
      makeCloudflare({
        accounts: [ACCOUNT, other],
        zones: [
          { ...ZONE, account: ACCOUNT.id },
          { id: "zone000000000000000000000000002", name: "example.org", account: ACCOUNT.id },
        ],
      }),
    );
    const accounts = await saveToken(m);
    expect(accounts.code).toBe(2);
    expect(accounts.err).toContain(
      `the token sees 2 accounts: ${ACCOUNT.id} (Owner's account), ${other.id} (Work)`,
    );
    expect(accounts.err).toContain("pass --account <id> to pick one");
    const zones = await saveToken(m, ["--account", ACCOUNT.id]);
    expect(zones.code).toBe(2);
    expect(zones.err).toContain("the token sees 2 zones: example.com, example.org");
    const unknown = await saveToken(m, ["--account", ACCOUNT.id, "--zone", "example.net"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("the token sees no zone example.net");
    const picked = await saveToken(m, ["--account", ACCOUNT.id, "--zone", "Example.ORG"]);
    expect(picked.code).toBe(0);
    expect(JSON.parse(readFileSync(cloudflareFile(m.home), "utf8"))).toMatchObject({
      zone: "example.org",
      zoneId: "zone000000000000000000000000002",
    });
    expect(`${accounts.err}${zones.err}${unknown.err}${picked.err}`).not.toContain(
      CLOUDFLARE_TOKEN,
    );
  });
});

const savedWith = async (endsInMs: number) => {
  const m = makeMachine();
  const account = oauthAccount(Date.now() + endsInMs);
  await runWith(m.host, saveCloudflare(m.home, account));
  return { m, account };
};

describe("an OAuth login the hub calls Cloudflare with", () => {
  test("is used as it is while it is fresh", async () => {
    const { m, account } = await savedWith(3_600_000);
    const { post, sent } = tokenEndpoint(tokenAnswer(NEW_ACCESS, NEW_REFRESH));
    expect((await runWith(m.host, bearerOf(m.home, account, post))).value).toBe(OAUTH_ACCESS);
    expect(sent).toEqual([]);
    expect(savedFile(m)).toEqual(account);
  });

  test("close to its end is renewed with the refresh token, and the new tokens are saved", async () => {
    const { m, account } = await savedWith(60_000);
    const { post, sent } = tokenEndpoint(tokenAnswer(NEW_ACCESS, NEW_REFRESH));
    expect((await runWith(m.host, bearerOf(m.home, account, post))).value).toBe(NEW_ACCESS);
    expect(sent).toEqual([
      { grant_type: "refresh_token", refresh_token: OAUTH_REFRESH, client_id: CLIENT },
    ]);
    const saved = savedFile(m);
    expect(saved).toMatchObject({
      ...account,
      login: {
        kind: "oauth",
        clientId: CLIENT,
        accessToken: NEW_ACCESS,
        refreshToken: NEW_REFRESH,
      },
    });
    if (saved.login.kind !== "oauth") throw new Error("expected an OAuth login");
    expect(Date.parse(saved.login.expiresAt) - Date.now()).toBeGreaterThan(3_500_000);
    expect(statSync(cloudflareFile(m.home)).mode & 0o777).toBe(0o600);
  });

  test("that Cloudflare refuses to renew fails, says to sign in again, and holds no token", async () => {
    const { m, account } = await savedWith(60_000);
    const { post } = tokenEndpoint({
      status: 401,
      body: JSON.stringify({ error: "invalid_grant", error_description: OAUTH_REFRESH }),
    });
    const error = (await runWith(m.host, Effect.flip(bearerOf(m.home, account, post)))).value;
    expect(error.message).toBe(
      `Cloudflare refused to renew the hub's login (401, invalid_grant); sign in again with \`devbox hub cloudflare login --client-id ${CLIENT}\``,
    );
    for (const secret of [OAUTH_ACCESS, OAUTH_REFRESH])
      expect(`${error.message} ${error.hint}`).not.toContain(secret);
    expect(savedFile(m)).toEqual(account);
  });

  test("needed by two requests at once is renewed once", async () => {
    const { m, account } = await savedWith(60_000);
    const { post, sent } = tokenEndpoint(tokenAnswer(NEW_ACCESS, NEW_REFRESH), 50);
    const bearers = await runWith(
      m.host,
      Effect.all([bearerOf(m.home, account, post), bearerOf(m.home, account, post)], {
        concurrency: "unbounded",
      }),
    );
    expect(bearers.value).toEqual([NEW_ACCESS, NEW_ACCESS]);
    expect(sent).toHaveLength(1);
  });
});

const TOKEN = "made-up-hub-token-0123456789abcdefghijklmnop";
const NOW = Date.parse("2026-11-27T12:00:00.000Z");

const tailnetAt = (ip: string) => ({
  ip,
  dns: "edge.tail1234.ts.net",
  os: "linux",
  online: true,
  lastSeen: null,
});

const machine = (
  name: string,
  spoke: HubMachine["spoke"],
  tailscale: HubMachine["tailscale"] = tailnetAt("100.64.0.22"),
): HubMachine => ({
  name,
  here: false,
  kind: "computer",
  state: "t3",
  tailscale,
  t3: null,
  vitals: null,
  spoke,
  tunnel: null,
});

const snapshot = (cloudflare: HubSnapshot["cloudflare"]): HubSnapshot => ({
  generatedAt: "2026-11-27T12:00:00.000Z",
  tailscale: true,
  machines: [
    machine("edge-7", "trusted"),
    machine("edge-8", "untrusted"),
    machine("edge-9", null),
    machine("edge-10", "trusted", null),
    machine("edge-11", "trusted", { ...tailnetAt(""), online: false }),
  ],
  history: { sampleSeconds: 60, startedAt: "2026-11-27T12:00:00.000Z", states: {}, latency: {} },
  latest: { t3: null },
  key: "made-up-public-key",
  cloudflare,
});

const ask = (
  method: string,
  name: string,
  headers: HubRequest["headers"] = { authorization: `Bearer ${TOKEN}` },
  cloudflare: HubSnapshot["cloudflare"] = { zone: "example.com", kind: "token" },
) =>
  route(
    {
      method,
      url: `/api/machines/${encodeURIComponent(name)}/tunnel`,
      headers: { host: "hub.tail1234.ts.net:3780", ...headers },
      body: "",
    },
    { snapshot: snapshot(cloudflare), token: TOKEN, now: NOW },
    () => undefined,
  );

const replied = (routed: ReturnType<typeof ask>): Reply => {
  if (!("status" in routed)) throw new Error(`asked ${routed.ask} instead of replying`);
  return routed;
};

const errorOf = (routed: ReturnType<typeof ask>) =>
  (JSON.parse(String(replied(routed).body)) as { error: string }).error;

describe("the tunnel routes pass the same admission step as update and pair", () => {
  for (const method of ["POST", "DELETE"]) {
    test(`${method} without a login: 401`, () => {
      expect(replied(ask(method, "edge-7", {})).status).toBe(401);
      expect(replied(ask(method, "edge-7", { authorization: "Bearer x" })).status).toBe(401);
    });

    test(`${method} from a page on another site: 403`, () => {
      const routed = ask(method, "edge-7", {
        authorization: `Bearer ${TOKEN}`,
        origin: "https://example.com",
      });
      expect(replied(routed).status).toBe(403);
    });

    test(`${method} for a machine the hub does not know: 404`, () => {
      expect(replied(ask(method, "edge-99")).status).toBe(404);
    });

    test(`${method} for a machine whose spoke does not trust this hub: 409`, () => {
      expect(replied(ask(method, "edge-8")).status).toBe(409);
      expect(errorOf(ask(method, "edge-8"))).toBe("edge-8 does not trust this hub's key.");
      expect(errorOf(ask(method, "edge-9"))).toBe("edge-9 has no devbox spoke that answers.");
    });

    test(`${method} without a Cloudflare login: 409`, () => {
      const routed = ask(method, "edge-7", undefined, null);
      expect(replied(routed).status).toBe(409);
      expect(errorOf(routed)).toBe(
        "The hub has no Cloudflare login. Connect one under Settings on the hub page, or run devbox hub cloudflare token.",
      );
    });

    test(`${method} for a machine without a Tailscale address: 409`, () => {
      expect(replied(ask(method, "edge-10")).status).toBe(409);
      expect(errorOf(ask(method, "edge-10"))).toBe(
        "edge-10 has no Tailscale address for a tunnel to reach.",
      );
      expect(replied(ask(method, "edge-11")).status).toBe(409);
    });
  }

  test("POST publishes and DELETE unpublishes; any other method: 405", () => {
    expect(ask("POST", "edge-7")).toMatchObject({ ask: "tunnel", machine: { name: "edge-7" } });
    expect(ask("DELETE", "edge-7")).toMatchObject({ ask: "untunnel" });
    const get = replied(ask("GET", "edge-7"));
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST, DELETE");
    expect(replied(ask("PUT", "edge-7")).status).toBe(405);
    expect(replied(ask("GET", "edge-7", {})).status).toBe(401);
  });
});

const SPOKE_PORT = "3900";

const node = (name: string, ip: string) => ({
  HostName: name,
  DNSName: `${name}.tail1234.ts.net.`,
  TailscaleIPs: [ip],
  OS: "linux",
  Online: true,
});

for (const kind of ["token", "oauth"] as const)
  describe(`devbox hub with a Cloudflare ${kind} login`, async () => {
    const cf = makeCloudflare({ bearer: kind === "token" ? CLOUDFLARE_TOKEN : OAUTH_ACCESS });
    const m = makeMachine();
    m.answer = (url, request) => cf.answer(url, request);
    if (kind === "token") await saveToken(m);
    else await runWith(m.host, saveCloudflare(m.home, oauthAccount(Date.now() + 3_600_000)));
    const key = (await devbox({ HOME: m.home }, ["hub", "key"], { host: m.host })).out.trim();
    m.binaries.add("tailscale");
    m.respond = (argv) =>
      argv[0] === "tailscale"
        ? {
            code: 0,
            stdout: JSON.stringify({
              Self: node("edge-7", "100.64.0.21"),
              Peer: { a: node("edge-8", "100.64.0.22") },
            }),
            stderr: "",
          }
        : undefined;
    m.pages.set(
      `http://100.64.0.22:${SPOKE_PORT}/api/spoke`,
      JSON.stringify({
        kind: "computer",
        vitals: { load: 0, memory: { used: 1, total: 2 }, disk: { used: 1, total: 2 } },
        trusts: [fingerprint(key)],
      }),
    );
    let nonce = 0;
    const challenge = () => `edge-8-challenge-${String((nonce += 1)).padStart(4, "0")}`;
    m.pages.set(
      `http://100.64.0.22:${SPOKE_PORT}/api/challenge`,
      JSON.stringify({ nonce: challenge() }),
    );
    m.answerPost = (posted) => {
      m.pages.set(
        `http://100.64.0.22:${SPOKE_PORT}/api/challenge`,
        JSON.stringify({ nonce: challenge() }),
      );
      return posted.url.endsWith("/api/do") ? "" : undefined;
    };

    const port = await Effect.runPromise(freePort);
    const empty = mkdtempSync(join(tmpdir(), "devbox-hub-ui-"));
    const hub = start(
      { HOME: m.home },
      ["hub", "--port", String(port), "--spoke-port", SPOKE_PORT, "--ui", empty],
      { host: m.host },
    );
    for (let i = 0; i < 100 && !hub.err().includes("hub:"); i += 1) await Bun.sleep(20);
    afterAll(() => hub.stop());
    const base = `http://127.0.0.1:${port}`;
    const token = (await devbox({ HOME: m.home }, ["hub", "token"], { host: m.host })).out.trim();
    const owner = { authorization: `Bearer ${token}` };
    const machines = async () => {
      const text = await (await fetch(`${base}/api/machines`, { headers: owner })).text();
      return { text, snapshot: JSON.parse(text) as HubSnapshot };
    };
    const tunnelOf = async (name: string) =>
      (await machines()).snapshot.machines.find((x) => x.name === name)?.tunnel;
    const tunnel = (method: string, name = "edge-8") =>
      fetch(`${base}/api/machines/${name}/tunnel`, { method, headers: owner });

    test("the snapshot names the zone, and no machine has a tunnel yet", async () => {
      const seen = (await machines()).snapshot;
      expect(seen.cloudflare).toEqual({ zone: "example.com", kind });
      expect(seen.machines.map((x) => x.tunnel)).toEqual([null, null]);
    });

    test("publishing: 202 with the address, and the spoke gets the token in a signed request", async () => {
      const before = m.posts.length;
      const response = await tunnel("POST");
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ url: "https://t3-edge-8.example.com" });
      const sent = m.posts.slice(before).find((p) => p.url.endsWith("/api/do"));
      expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({
        do: "tunnel",
        token: TUNNEL_TOKEN,
        url: "https://t3-edge-8.example.com",
      });
      const { nonce: sentNonce } = JSON.parse(sent?.body ?? "{}") as { nonce: string };
      const verdict = verifyRequest(
        {
          body: sent?.body ?? "",
          key: sent?.headers?.["x-devbox-key"],
          signature: sent?.headers?.["x-devbox-signature"],
        },
        [key],
        Date.now(),
        handOut(new Map(), sentNonce, Date.now()),
      );
      expect(verdict).toMatchObject({
        ok: true,
        do: "tunnel",
        fields: { token: TUNNEL_TOKEN, url: "https://t3-edge-8.example.com" },
      });
      expect(await tunnelOf("edge-8")).toEqual({ url: "https://t3-edge-8.example.com" });
    });

    test("no secret reaches the snapshot, the hub's log, or tunnels.json", async () => {
      const { text } = await machines();
      const remembered = readFileSync(tunnelsFile(m.home), "utf8");
      for (const secret of [CLOUDFLARE_TOKEN, OAUTH_ACCESS, OAUTH_REFRESH, TUNNEL_TOKEN, token]) {
        expect(text).not.toContain(secret);
        expect(hub.err()).not.toContain(secret);
        expect(hub.out()).not.toContain(secret);
        expect(remembered).not.toContain(secret);
      }
    });

    test("when Cloudflare refuses a step: 502 that names it and what Cloudflare said", async () => {
      cf.refuse = (c) => (c.path.endsWith("/token") ? "Tunnel token is not available" : undefined);
      const response = await tunnel("POST");
      cf.refuse = () => undefined;
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error:
          "Publishing edge-8 stopped when devbox tried to get the tunnel token: Tunnel token is not available",
        step: "get the tunnel token",
      });
    });

    test("when the spoke does not take it: 502", async () => {
      const answerPost = m.answerPost;
      m.answerPost = () => false;
      const response = await tunnel("DELETE");
      m.answerPost = answerPost;
      expect(response.status).toBe(502);
      expect(((await response.json()) as { step: string }).step).toBe(
        "take the tunnel from the machine",
      );
      expect(stateOf(cf).records).toHaveLength(1);
    });

    test("unpublishing: 204, the spoke is told, and the machine has no tunnel", async () => {
      const before = m.posts.length;
      const response = await tunnel("DELETE");
      expect(response.status).toBe(204);
      const sent = m.posts.slice(before).find((p) => p.url.endsWith("/api/do"));
      expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({ do: "untunnel" });
      expect(JSON.parse(sent?.body ?? "{}")).not.toHaveProperty("token");
      expect(await tunnelOf("edge-8")).toBeNull();
      expect(stateOf(cf)).toEqual({ rules: [], tunnels: [], ingress: [], records: [] });
    });

    test("a publish and an unpublish at once run one after the other", async () => {
      const [published, unpublished] = await Promise.all([tunnel("POST"), tunnel("DELETE")]);
      expect([published.status, unpublished.status]).toEqual([202, 204]);
      expect(stateOf(cf)).toEqual({ rules: [], tunnels: [], ingress: [], records: [] });
      expect(await tunnelOf("edge-8")).toBeNull();
      const [again, last] = await Promise.all([tunnel("DELETE"), tunnel("POST")]);
      expect([again.status, last.status]).toEqual([204, 202]);
      expect(stateOf(cf).records).toHaveLength(1);
      expect(await tunnelOf("edge-8")).toEqual({ url: "https://t3-edge-8.example.com" });
    });

    test("a machine without a spoke that trusts the hub: 409, and Cloudflare is not asked", async () => {
      const from = cf.calls.length;
      expect((await tunnel("POST", "edge-7")).status).toBe(409);
      expect(cf.calls.length).toBe(from);
    });
  });

const settings = (
  method: string,
  body: string | null = "",
  headers: HubRequest["headers"] = { authorization: `Bearer ${TOKEN}` },
) =>
  route(
    {
      method,
      url: "/api/cloudflare",
      headers: { host: "hub.tail1234.ts.net:3780", ...headers },
      body,
    },
    { snapshot: snapshot(null), token: TOKEN, now: NOW },
    () => undefined,
  );

describe("the Cloudflare login over the hub's API", () => {
  test("needs a login before it says anything, whatever the method", () => {
    for (const method of ["GET", "PUT", "DELETE", "POST"])
      expect(replied(settings(method, "", {})).status).toBe(401);
  });

  test("is refused to a page on another site, even with the token: 403", () => {
    for (const method of ["PUT", "DELETE"]) {
      const routed = settings(method, JSON.stringify({ token: CLOUDFLARE_TOKEN }), {
        authorization: `Bearer ${TOKEN}`,
        origin: "https://example.com",
      });
      expect(replied(routed).status).toBe(403);
    }
  });

  test("PUT asks to connect with the token and the account and zone it names", () => {
    expect(settings("PUT", JSON.stringify({ token: CLOUDFLARE_TOKEN }))).toEqual({
      ask: "connect",
      token: CLOUDFLARE_TOKEN,
      account: Option.none(),
      zone: Option.none(),
    });
    const named = JSON.stringify({
      token: CLOUDFLARE_TOKEN,
      account: ACCOUNT.id,
      zone: "example.org",
    });
    expect(settings("PUT", named)).toEqual({
      ask: "connect",
      token: CLOUDFLARE_TOKEN,
      account: Option.some(ACCOUNT.id),
      zone: Option.some("example.org"),
    });
  });

  test("DELETE asks to disconnect, and any other method: 405", () => {
    expect(settings("DELETE")).toEqual({ ask: "disconnect" });
    for (const method of ["GET", "POST", "PATCH"]) {
      const r = replied(settings(method));
      expect(r.status).toBe(405);
      expect(r.headers.allow).toBe("PUT, DELETE");
    }
  });

  test("a body that is not {token, account?, zone?}: 400, and the reply never holds the token", () => {
    for (const body of [
      "",
      "null",
      "[]",
      CLOUDFLARE_TOKEN,
      JSON.stringify({ token: 7 }),
      JSON.stringify({ token: "" }),
      JSON.stringify({ token: `${CLOUDFLARE_TOKEN} two` }),
      JSON.stringify({ token: "x".repeat(1025) }),
      JSON.stringify({ secret: CLOUDFLARE_TOKEN }),
      JSON.stringify({ token: CLOUDFLARE_TOKEN, account: 7 }),
      JSON.stringify({ token: CLOUDFLARE_TOKEN, admin: true }),
    ]) {
      const r = replied(settings("PUT", body));
      expect(r.status).toBe(400);
      expect(String(r.body)).not.toContain(CLOUDFLARE_TOKEN);
    }
  });

  test("a body longer than the hub reads: 413, and the connection closes", () => {
    const r = replied(settings("PUT", null));
    expect(r.status).toBe(413);
    expect(r.headers.connection).toBe("close");
  });
});

describe("devbox hub, connected to Cloudflare from its page", async () => {
  const work = { id: "acc0000000000000000000000000002", name: "Work" };
  const cf = makeCloudflare({
    accounts: [ACCOUNT, work],
    zones: [
      { ...ZONE, account: ACCOUNT.id },
      { id: "zone000000000000000000000000002", name: "example.org", account: ACCOUNT.id },
    ],
  });
  const m = makeMachine();
  m.answer = (url, request) => cf.answer(url, request);
  const port = await Effect.runPromise(freePort);
  const empty = mkdtempSync(join(tmpdir(), "devbox-hub-ui-"));
  const hub = start({ HOME: m.home }, ["hub", "--port", String(port), "--ui", empty], {
    host: m.host,
  });
  for (let i = 0; i < 100 && !hub.err().includes("hub:"); i += 1) await Bun.sleep(20);
  afterAll(() => hub.stop());
  const base = `http://127.0.0.1:${port}`;
  const token = (await devbox({ HOME: m.home }, ["hub", "token"], { host: m.host })).out.trim();
  const page = { authorization: `Bearer ${token}`, origin: base };
  const replies: Array<string> = [];

  const send = async (method: string, body?: object | string) => {
    const response = await fetch(`${base}/api/cloudflare`, {
      method,
      headers: page,
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    replies.push(text);
    return { status: response.status, json: text === "" ? undefined : JSON.parse(text) };
  };

  const loginNow = async () => {
    const text = await (await fetch(`${base}/api/machines`, { headers: page })).text();
    replies.push(text);
    return (JSON.parse(text) as HubSnapshot).cloudflare;
  };

  test("with no login saved, the snapshot says so", async () => {
    expect(await loginNow()).toBeNull();
  });

  test("a token that sees two accounts: 409 that names them, and nothing is saved", async () => {
    expect(await send("PUT", { token: CLOUDFLARE_TOKEN })).toEqual({
      status: 409,
      json: {
        error: 'The token sees 2 accounts. Name one as "account".',
        accounts: [ACCOUNT, work],
      },
    });
    expect(existsSync(cloudflareFile(m.home))).toBe(false);
  });

  test("with the account named but two zones: 409 that names the zones", async () => {
    expect(await send("PUT", { token: CLOUDFLARE_TOKEN, account: ACCOUNT.id })).toEqual({
      status: 409,
      json: {
        error: 'The token sees 2 zones. Name one as "zone".',
        zones: [
          { id: ZONE.id, name: "example.com" },
          { id: "zone000000000000000000000000002", name: "example.org" },
        ],
      },
    });
    expect(existsSync(cloudflareFile(m.home))).toBe(false);
  });

  test("with both named: 200, the login is saved, and the very next snapshot shows it", async () => {
    const saved = await send("PUT", {
      token: CLOUDFLARE_TOKEN,
      account: ACCOUNT.id,
      zone: "Example.ORG",
    });
    expect(saved).toEqual({ status: 200, json: { zone: "example.org", kind: "token" } });
    expect(statSync(cloudflareFile(m.home)).mode & 0o777).toBe(0o600);
    expect(savedFile(m)).toMatchObject({ login: { kind: "token" }, zone: "example.org" });
    expect(await loginNow()).toEqual({ zone: "example.org", kind: "token" });
  });

  test("a token Cloudflare refuses: 502 with what Cloudflare said, and the saved login stays", async () => {
    cf.refuse = () => `Invalid API Token ${CLOUDFLARE_TOKEN}`;
    const refused = await send("PUT", { token: CLOUDFLARE_TOKEN, account: ACCOUNT.id });
    cf.refuse = () => undefined;
    expect(refused).toEqual({
      status: 502,
      json: {
        error: "Cloudflare refused to list the accounts this token sees: Invalid API Token <token>",
      },
    });
    expect(await loginNow()).toEqual({ zone: "example.org", kind: "token" });
  });

  test("a body past two kilobytes is cut off, and the hub still answers", async () => {
    expect((await send("PUT", JSON.stringify({ token: "x".repeat(4096) }))).status).toBe(413);
    expect(await loginNow()).toEqual({ zone: "example.org", kind: "token" });
  });

  test("DELETE: 204, the file is gone, the very next snapshot has no login, and again is 204", async () => {
    expect(await send("DELETE")).toEqual({ status: 204, json: undefined });
    expect(existsSync(cloudflareFile(m.home))).toBe(false);
    expect(await loginNow()).toBeNull();
    expect((await send("DELETE")).status).toBe(204);
  });

  test("the token is in no reply and never in the hub's log", () => {
    expect(replies.length).toBeGreaterThan(5);
    for (const text of [...replies, hub.err(), hub.out()]) {
      expect(text).not.toContain(CLOUDFLARE_TOKEN);
      expect(text).not.toContain(token);
    }
  });
});

describe("a request devbox makes", () => {
  test("gives any status with its body, and nothing for an answer too large to read", async () => {
    const port = await Effect.runPromise(freePort);
    const server = http.createServer((req, res) => {
      if (req.url === "/huge") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("x".repeat(2 * 1024 * 1024));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, method: req.method }));
      }
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const request = (path: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const host = yield* Host;
          return yield* host.request(`http://127.0.0.1:${port}${path}`, { method: "DELETE" }, 5000);
        }).pipe(Effect.provide(Host.layer)),
      );
    try {
      expect(await request("/missing")).toEqual(
        Option.some({ status: 404, body: JSON.stringify({ success: false, method: "DELETE" }) }),
      );
      expect(await request("/huge")).toEqual(Option.none());
    } finally {
      server.close();
    }
  });
});
