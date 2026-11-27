import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Schema } from "effect";
import { constUndefined } from "effect/Function";

import { keyFile, tokenFile } from "../src/hub/secrets.ts";
import { freePort } from "../src/machine/proxy.ts";
import { fingerprint, handOut, verifyRequest } from "../src/spoke/signed.ts";
import { makeMachine } from "./support/host.ts";
import { readJson } from "./support/json.ts";
import { devbox, start, untilListening } from "./support/run.ts";

const SPOKE_PORT = "3900";

const VITALS = {
  load: 0.12,
  memory: { used: 5_100_000_000, total: 16_000_000_000 },
  disk: { used: 61, total: 100 },
};

const node = (name: string, ip: string) => ({
  HostName: name,
  DNSName: `${name}.tail1234.ts.net.`,
  TailscaleIPs: [ip],
  OS: "linux",
  Online: true,
});

const spokeUrl = (ip: string) => `http://${ip}:${SPOKE_PORT}/api/spoke`;
const challengeUrl = (ip: string) => `http://${ip}:${SPOKE_PORT}/api/challenge`;
const challenge = (nonce: string) => JSON.stringify({ nonce });

const spokeAnswer = (trusted: readonly string[], kind = "computer") =>
  JSON.stringify({ kind, vitals: VITALS, trusts: trusted });

const Listed = Schema.Struct({
  machines: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      kind: Schema.String,
      spoke: Schema.NullOr(Schema.String),
      vitals: Schema.Unknown,
    })
  ),
});

const Sent = Schema.Struct({ nonce: Schema.optional(Schema.String) });

const statusOf = async (response: Promise<Response>) => {
  const { status } = await response;

  return status;
};

const textOf = async (response: Promise<Response>) => {
  const answered = await response;

  return await answered.text();
};

const PAIRING_LINK =
  "http://edge-8.tail1234.ts.net:3773/pair#token=made-up-pairing-token-0123";

const tailnet = async () => {
  const m = makeMachine();

  const made = await devbox({ HOME: m.home }, ["hub", "key"], {
    host: m.host,
  });

  const key = made.out.trim();

  m.binaries.add("tailscale");
  m.respond = (argv) =>
    argv[0] === "tailscale"
      ? {
          code: 0,
          stdout: JSON.stringify({
            Self: node("edge-7", "100.64.0.21"),
            Peer: {
              a: node("edge-8", "100.64.0.22"),
              b: node("edge-9", "100.64.0.23"),
              c: node("edge-10", "100.64.0.24"),
            },
          }),
          stderr: "",
        }
      : undefined;

  m.pages.set(spokeUrl("100.64.0.22"), spokeAnswer([fingerprint(key)]));
  m.pages.set(spokeUrl("100.64.0.23"), spokeAnswer(["someone-else"]));
  m.pages.set(spokeUrl("100.64.0.24"), spokeAnswer([fingerprint(key)], "vm"));
  m.pages.set(challengeUrl("100.64.0.22"), challenge("edge-8-challenge-0001"));
  m.pages.set(challengeUrl("100.64.0.24"), challenge("edge-10-challenge-0001"));

  return { m, key };
};

const startHub = async () => {
  const { m, key } = await tailnet();
  const port = await Effect.runPromise(freePort);
  const empty = mkdtempSync(path.join(tmpdir(), "devbox-hub-ui-"));

  const hub = start(
    { HOME: m.home },
    ["hub", "--port", String(port), "--spoke-port", SPOKE_PORT, "--ui", empty],
    { host: m.host }
  );

  await untilListening(hub);
  const base = `http://127.0.0.1:${port}`;

  const issued = await devbox({ HOME: m.home }, ["hub", "token"], {
    host: m.host,
  });

  const token = issued.out.trim();
  const owner = { authorization: `Bearer ${token}` };

  const listed = await textOf(
    fetch(`${base}/api/machines`, { headers: owner })
  );

  return { m, key, hub, base, token, owner, listed };
};

const running = await startHub();

describe("devbox hub with spokes", () => {
  const { m, key, hub, base, token, owner, listed } = running;

  const snapshot = readJson(
    Schema.Struct({ key: Schema.String, ...Listed.fields }),
    listed
  );

  afterAll(async () => {
    await hub.stop();
  });

  const machine = (name: string) =>
    snapshot.machines.find((x) => x.name === name);

  const ask = async (
    name: string,
    headers: Record<string, string> = {},
    action = "update"
  ) =>
    await fetch(`${base}/api/machines/${encodeURIComponent(name)}/${action}`, {
      method: "POST",
      headers: { ...owner, ...headers },
    });

  test("the key and the token are made once, for this user alone", () => {
    expect(statSync(keyFile(m.home)).mode & 0o777).toBe(0o600);
    expect(statSync(tokenFile(m.home)).mode & 0o777).toBe(0o600);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(readFileSync(keyFile(m.home), "utf-8")).toContain("PRIVATE KEY");
  });

  test("the snapshot carries the public key, and never the token or the private key", async () => {
    const text = await textOf(
      fetch(`${base}/api/machines`, { headers: owner })
    );

    expect(snapshot.key).toBe(key);
    expect(text).not.toContain(token);
    expect(text).not.toContain("PRIVATE KEY");
    expect(hub.err()).not.toContain(token);
    expect(hub.err()).not.toContain(key);
  });

  test("a spoke's answer fills vitals, says whether it trusts this hub, and names its kind", () => {
    expect(machine("edge-7")).toMatchObject({
      vitals: null,
      spoke: null,
      kind: "computer",
    });
    expect(machine("edge-8")).toMatchObject({
      vitals: VITALS,
      spoke: "trusted",
      kind: "computer",
    });
    expect(machine("edge-9")).toMatchObject({
      vitals: VITALS,
      spoke: "untrusted",
    });
    expect(machine("edge-10")).toMatchObject({ kind: "vm", spoke: "trusted" });
  });

  test("this machine's spoke is asked on its Tailscale address, then on loopback", () => {
    expect(m.fetches).toContain(spokeUrl("100.64.0.21"));
    expect(m.fetches).toContain(spokeUrl("127.0.0.1"));
  });

  test("without an authorization header: 401", async () => {
    const response = await fetch(`${base}/api/machines/edge-8/update`, {
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(m.posts).toEqual([]);
  });

  test("with a wrong token, which is no login: 401", async () => {
    expect(
      await statusOf(
        ask("edge-8", { authorization: `Bearer ${token.slice(1)}x` })
      )
    ).toBe(401);
    expect(await statusOf(ask("edge-8", { authorization: "Bearer x" }))).toBe(
      401
    );
    expect(await statusOf(ask("edge-8", { authorization: token }))).toBe(401);
    expect(
      await statusOf(ask("edge-8", { authorization: "Bearer x" }, "pair"))
    ).toBe(401);
    expect(m.posts).toEqual([]);
  });

  test("from a page on another site, even with the token: 403", async () => {
    const response = await ask("edge-8", { origin: "https://example.com" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "This request came from a page on another site.",
    });
    expect(await statusOf(ask("edge-8", { origin: "null" }))).toBe(403);
    expect(
      await statusOf(ask("edge-8", { origin: "https://example.com" }, "pair"))
    ).toBe(403);
    expect(m.posts).toEqual([]);
  });

  test("through a proxy, the page is the one the browser asked, which X-Forwarded-Host names", async () => {
    const forwarded = { "x-forwarded-host": "localhost:3790" };

    const logout = async (headers: Record<string, string>) =>
      await fetch(`${base}/api/logout`, {
        method: "POST",
        headers: { ...owner, ...headers },
      });

    expect(
      await statusOf(logout({ origin: "http://localhost:3790", ...forwarded }))
    ).toBe(204);
    expect(
      await statusOf(logout({ origin: "https://example.com", ...forwarded }))
    ).toBe(403);
    expect(await statusOf(logout({ origin: base, ...forwarded }))).toBe(403);
    expect(await statusOf(logout({ origin: "http://localhost:3790" }))).toBe(
      403
    );
  });

  test("for a machine the hub does not know: 404", async () => {
    expect(await statusOf(ask("edge-99"))).toBe(404);
    expect(await statusOf(ask("</script><script>alert(1)</script>"))).toBe(404);
    expect(await statusOf(ask("edge-8/../edge-8"))).toBe(404);
    expect(await statusOf(ask("edge-99", {}, "pair"))).toBe(404);

    const broken = await fetch(`${base}/api/machines/%E0%A4%A/update`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(broken.status).toBe(404);
    expect(m.posts).toEqual([]);
  });

  test("for a machine whose spoke does not trust this hub, or that has none: 409", async () => {
    expect(await statusOf(ask("edge-9"))).toBe(409);
    const none = await ask("edge-7");
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({
      error: "edge-7 has no devbox spoke that answers.",
    });
    const pair = await ask("edge-9", {}, "pair");
    expect(pair.status).toBe(409);
    expect(await pair.json()).toEqual({
      error: "edge-9 does not trust this hub's key.",
    });
    expect(await statusOf(ask("edge-7", {}, "pair"))).toBe(409);
    expect(m.posts).toEqual([]);
  });

  const nonceSent = (index: number) =>
    readJson(Sent, m.posts[index]?.body ?? "{}").nonce;

  test("when the spoke takes it: 202, sent signed to answer that spoke's challenge", async () => {
    let fetchedBeforePost: readonly string[] = [];
    const { answerPost } = m;

    m.answerPost = (posted) => {
      fetchedBeforePost = [...m.fetches];

      return answerPost(posted);
    };

    const response = await ask("edge-8", { origin: base });
    m.answerPost = answerPost;
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ asked: true });
    expect(fetchedBeforePost).toContain(challengeUrl("100.64.0.22"));
    expect(m.posts).toHaveLength(1);
    const [sent] = m.posts;
    expect(sent?.url).toBe(`http://100.64.0.22:${SPOKE_PORT}/api/do`);
    expect(sent?.contentType).toBe("application/json");
    expect(sent?.headers?.["x-devbox-key"]).toBe(fingerprint(key));
    expect(nonceSent(0)).toBe("edge-8-challenge-0001");
    expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({ do: "update" });

    const verdict = verifyRequest(
      {
        body: sent?.body ?? "",
        key: sent?.headers?.["x-devbox-key"],
        signature: sent?.headers?.["x-devbox-signature"],
      },
      [key],
      Date.now(),
      handOut(new Map(), "edge-8-challenge-0001", Date.now())
    );

    expect(verdict.ok).toBe(true);
    expect(sent?.body).not.toContain(token);
  });

  test("each request answers the challenge the spoke handed out for it", async () => {
    m.pages.set(
      challengeUrl("100.64.0.22"),
      challenge("edge-8-challenge-0002")
    );
    expect(await statusOf(ask("edge-8"))).toBe(202);
    expect(nonceSent(m.posts.length - 1)).toBe("edge-8-challenge-0002");
  });

  test("when the spoke gives no challenge: 502, and nothing is posted", async () => {
    const before = m.posts.length;
    m.pages.delete(challengeUrl("100.64.0.24"));
    const response = await ask("edge-10");
    m.pages.set(
      challengeUrl("100.64.0.24"),
      challenge("edge-10-challenge-0001")
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "edge-10 did not take the update.",
    });
    expect(m.posts).toHaveLength(before);
  });

  test("when the spoke refuses or does not answer: 502", async () => {
    m.answerPost = (posted) =>
      posted.url.includes("100.64.0.24") ? false : undefined;
    const response = await ask("edge-10");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "edge-10 did not take the update.",
    });
  });

  test("a pairing request: 200 with the spoke's link, never stored or logged", async () => {
    const before = m.posts.length;
    m.answerPost = (posted) =>
      posted.url.includes("100.64.0.22")
        ? JSON.stringify({ url: PAIRING_LINK })
        : undefined;
    const response = await ask("edge-8", { origin: base }, "pair");
    m.answerPost = constUndefined;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ url: PAIRING_LINK });
    const sent = m.posts[before];
    expect(sent?.url).toBe(`http://100.64.0.22:${SPOKE_PORT}/api/do`);
    expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({ do: "pair" });
    expect(hub.err()).not.toContain("made-up-pairing-token-0123");
    expect(hub.out()).not.toContain("made-up-pairing-token-0123");

    const later = await textOf(
      fetch(`${base}/api/machines`, { headers: owner })
    );

    expect(later).not.toContain("made-up-pairing-token-0123");
  });

  test("a pairing request the spoke refuses, or answers without a link: 502", async () => {
    m.answerPost = () => false;
    const refused = await ask("edge-10", {}, "pair");
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({
      error: "edge-10 gave no pairing link.",
    });
    // oxlint-disable-next-line eslint/no-script-url -- the hub must refuse a script link a spoke hands back
    m.answerPost = () => JSON.stringify({ url: "javascript:alert(1)" });
    expect(await statusOf(ask("edge-10", {}, "pair"))).toBe(502);
    m.answerPost = () => "not json";
    expect(await statusOf(ask("edge-10", {}, "pair"))).toBe(502);
    m.answerPost = constUndefined;
  });

  test("machine paths take only POST, and every other path stays GET only", async () => {
    expect(await statusOf(fetch(`${base}/api/machines/edge-8/update`))).toBe(
      401
    );
    expect(
      await statusOf(
        fetch(`${base}/api/machines/edge-8/update`, { headers: owner })
      )
    ).toBe(405);
    expect(
      await statusOf(
        fetch(`${base}/api/machines/edge-8/pair`, { headers: owner })
      )
    ).toBe(405);

    const posted = await fetch(`${base}/api/machines`, {
      method: "POST",
      headers: owner,
    });

    expect(posted.status).toBe(405);
    expect(await statusOf(fetch(`${base}/`, { method: "POST" }))).toBe(405);
  });

  test("a large body is not read, and the hub still answers", async () => {
    const before = m.posts.length;

    const answered = Promise.withResolvers<number>();

    const req = http.request(
      `${base}/api/machines/edge-8/update`,
      { method: "POST", headers: { authorization: "Bearer wrong" } },
      (response) => {
        response.resume();
        answered.resolve(response.statusCode ?? 0);
      }
    );

    req.on("error", answered.reject);
    req.end("x".repeat(256 * 1024));
    const status = await answered.promise;

    expect(status).toBe(401);
    expect(m.posts).toHaveLength(before);
    expect(
      await statusOf(fetch(`${base}/api/machines`, { headers: owner }))
    ).toBe(200);
  });
});

test("devbox machines has no hub key, so it says nothing about trust", async () => {
  const { m } = await tailnet();

  const r = await devbox(
    { HOME: m.home },
    ["machines", "--json", "--spoke-port", SPOKE_PORT],
    {
      host: m.host,
    }
  );

  const json = readJson(Listed, r.out);
  expect(json.machines.map((x) => x.spoke)).toEqual([null, null, null, null]);
  expect(json.machines.find((x) => x.name === "edge-8")?.vitals).toEqual(
    VITALS
  );
});
