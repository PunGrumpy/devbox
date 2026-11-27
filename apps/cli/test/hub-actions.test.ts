import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { HubSnapshot } from "../src/hub/hub.ts";
import type { Machine } from "../src/hub/machines.ts";
import { keyFile, tokenFile } from "../src/hub/secrets.ts";
import { freePort } from "../src/machine/proxy.ts";
import { fingerprint, handOut, verifyRequest } from "../src/spoke/signed.ts";
import { makeMachine } from "./support/host.ts";
import { devbox, start } from "./support/run.ts";

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
const PAIRING_LINK = "http://edge-8.tail1234.ts.net:3773/pair#token=made-up-pairing-token-0123";

const tailnet = async () => {
  const m = makeMachine();
  const key = (await devbox({ HOME: m.home }, ["hub", "key"], { host: m.host })).out.trim();
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
  const answer = (trusts: ReadonlyArray<string>, kind = "computer") =>
    JSON.stringify({ kind, vitals: VITALS, trusts });
  m.pages.set(spokeUrl("100.64.0.22"), answer([fingerprint(key)]));
  m.pages.set(spokeUrl("100.64.0.23"), answer(["someone-else"]));
  m.pages.set(spokeUrl("100.64.0.24"), answer([fingerprint(key)], "vm"));
  m.pages.set(challengeUrl("100.64.0.22"), challenge("edge-8-challenge-0001"));
  m.pages.set(challengeUrl("100.64.0.24"), challenge("edge-10-challenge-0001"));
  return { m, key };
};

describe("devbox hub with spokes", async () => {
  const { m, key } = await tailnet();
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
  const snapshot = (await (
    await fetch(`${base}/api/machines`, { headers: owner })
  ).json()) as HubSnapshot;
  const machine = (name: string) => snapshot.machines.find((x: Machine) => x.name === name);

  const ask = (name: string, headers: Record<string, string> = {}, action = "update") =>
    fetch(`${base}/api/machines/${encodeURIComponent(name)}/${action}`, {
      method: "POST",
      headers: { ...owner, ...headers },
    });

  test("the key and the token are made once, for this user alone", () => {
    expect(statSync(keyFile(m.home)).mode & 0o777).toBe(0o600);
    expect(statSync(tokenFile(m.home)).mode & 0o777).toBe(0o600);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(readFileSync(keyFile(m.home), "utf8")).toContain("PRIVATE KEY");
  });

  test("the snapshot carries the public key, and never the token or the private key", async () => {
    const text = await (await fetch(`${base}/api/machines`, { headers: owner })).text();
    expect(snapshot.key).toBe(key);
    expect(text).not.toContain(token);
    expect(text).not.toContain("PRIVATE KEY");
    expect(hub.err()).not.toContain(token);
    expect(hub.err()).not.toContain(key);
  });

  test("a spoke's answer fills vitals, says whether it trusts this hub, and names its kind", () => {
    expect(machine("edge-7")).toMatchObject({ vitals: null, spoke: null, kind: "computer" });
    expect(machine("edge-8")).toMatchObject({ vitals: VITALS, spoke: "trusted", kind: "computer" });
    expect(machine("edge-9")).toMatchObject({ vitals: VITALS, spoke: "untrusted" });
    expect(machine("edge-10")).toMatchObject({ kind: "vm", spoke: "trusted" });
  });

  test("this machine's spoke is asked on its Tailscale address, then on loopback", () => {
    expect(m.fetches).toContain(spokeUrl("100.64.0.21"));
    expect(m.fetches).toContain(spokeUrl("127.0.0.1"));
  });

  test("without an authorization header: 401", async () => {
    const response = await fetch(`${base}/api/machines/edge-8/update`, { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(m.posts).toEqual([]);
  });

  test("with a wrong token, which is no login: 401", async () => {
    expect((await ask("edge-8", { authorization: `Bearer ${token.slice(1)}x` })).status).toBe(401);
    expect((await ask("edge-8", { authorization: "Bearer x" })).status).toBe(401);
    expect((await ask("edge-8", { authorization: token })).status).toBe(401);
    expect((await ask("edge-8", { authorization: "Bearer x" }, "pair")).status).toBe(401);
    expect(m.posts).toEqual([]);
  });

  test("from a page on another site, even with the token: 403", async () => {
    const response = await ask("edge-8", { origin: "https://example.com" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "This request came from a page on another site.",
    });
    expect((await ask("edge-8", { origin: "null" })).status).toBe(403);
    expect((await ask("edge-8", { origin: "https://example.com" }, "pair")).status).toBe(403);
    expect(m.posts).toEqual([]);
  });

  test("for a machine the hub does not know: 404", async () => {
    expect((await ask("edge-99")).status).toBe(404);
    expect((await ask("</script><script>alert(1)</script>")).status).toBe(404);
    expect((await ask("edge-8/../edge-8")).status).toBe(404);
    expect((await ask("edge-99", {}, "pair")).status).toBe(404);
    const broken = await fetch(`${base}/api/machines/%E0%A4%A/update`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(broken.status).toBe(404);
    expect(m.posts).toEqual([]);
  });

  test("for a machine whose spoke does not trust this hub, or that has none: 409", async () => {
    expect((await ask("edge-9")).status).toBe(409);
    const none = await ask("edge-7");
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: "edge-7 has no devbox spoke that answers." });
    const pair = await ask("edge-9", {}, "pair");
    expect(pair.status).toBe(409);
    expect(await pair.json()).toEqual({ error: "edge-9 does not trust this hub's key." });
    expect((await ask("edge-7", {}, "pair")).status).toBe(409);
    expect(m.posts).toEqual([]);
  });

  const nonceSent = (index: number) =>
    (JSON.parse(m.posts[index]?.body ?? "{}") as { nonce?: string }).nonce;

  test("when the spoke takes it: 202, sent signed to answer that spoke's challenge", async () => {
    let fetchedBeforePost: ReadonlyArray<string> = [];
    m.answerPost = () => {
      fetchedBeforePost = [...m.fetches];
      return undefined;
    };
    const response = await ask("edge-8", { origin: base });
    m.answerPost = () => undefined;
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
      handOut(new Map(), "edge-8-challenge-0001", Date.now()),
    );
    expect(verdict.ok).toBe(true);
    expect(sent?.body).not.toContain(token);
  });

  test("each request answers the challenge the spoke handed out for it", async () => {
    m.pages.set(challengeUrl("100.64.0.22"), challenge("edge-8-challenge-0002"));
    expect((await ask("edge-8")).status).toBe(202);
    expect(nonceSent(m.posts.length - 1)).toBe("edge-8-challenge-0002");
  });

  test("when the spoke gives no challenge: 502, and nothing is posted", async () => {
    const before = m.posts.length;
    m.pages.delete(challengeUrl("100.64.0.24"));
    const response = await ask("edge-10");
    m.pages.set(challengeUrl("100.64.0.24"), challenge("edge-10-challenge-0001"));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "edge-10 did not take the update." });
    expect(m.posts.length).toBe(before);
  });

  test("when the spoke refuses or does not answer: 502", async () => {
    m.answerPost = (posted) => (posted.url.includes("100.64.0.24") ? false : undefined);
    const response = await ask("edge-10");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "edge-10 did not take the update." });
  });

  test("a pairing request: 200 with the spoke's link, never stored or logged", async () => {
    const before = m.posts.length;
    m.answerPost = (posted) =>
      posted.url.includes("100.64.0.22") ? JSON.stringify({ url: PAIRING_LINK }) : undefined;
    const response = await ask("edge-8", { origin: base }, "pair");
    m.answerPost = () => undefined;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ url: PAIRING_LINK });
    const sent = m.posts[before];
    expect(sent?.url).toBe(`http://100.64.0.22:${SPOKE_PORT}/api/do`);
    expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({ do: "pair" });
    expect(hub.err()).not.toContain("made-up-pairing-token-0123");
    expect(hub.out()).not.toContain("made-up-pairing-token-0123");
    const later = await (await fetch(`${base}/api/machines`, { headers: owner })).text();
    expect(later).not.toContain("made-up-pairing-token-0123");
  });

  test("a pairing request the spoke refuses, or answers without a link: 502", async () => {
    m.answerPost = () => false;
    const refused = await ask("edge-10", {}, "pair");
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: "edge-10 gave no pairing link." });
    m.answerPost = () => JSON.stringify({ url: "javascript:alert(1)" });
    expect((await ask("edge-10", {}, "pair")).status).toBe(502);
    m.answerPost = () => "not json";
    expect((await ask("edge-10", {}, "pair")).status).toBe(502);
    m.answerPost = () => undefined;
  });

  test("machine paths take only POST, and every other path stays GET only", async () => {
    expect((await fetch(`${base}/api/machines/edge-8/update`)).status).toBe(401);
    expect((await fetch(`${base}/api/machines/edge-8/update`, { headers: owner })).status).toBe(
      405,
    );
    expect((await fetch(`${base}/api/machines/edge-8/pair`, { headers: owner })).status).toBe(405);
    const posted = await fetch(`${base}/api/machines`, { method: "POST", headers: owner });
    expect(posted.status).toBe(405);
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
  });

  test("a large body is not read, and the hub still answers", async () => {
    const before = m.posts.length;
    const status = await new Promise<number>((done, fail) => {
      const req = http.request(
        `${base}/api/machines/edge-8/update`,
        { method: "POST", headers: { authorization: "Bearer wrong" } },
        (response) => {
          response.resume();
          done(response.statusCode ?? 0);
        },
      );
      req.on("error", fail);
      req.end("x".repeat(256 * 1024));
    });
    expect(status).toBe(401);
    expect(m.posts.length).toBe(before);
    expect((await fetch(`${base}/api/machines`, { headers: owner })).status).toBe(200);
  });
});

test("devbox machines has no hub key, so it says nothing about trust", async () => {
  const { m } = await tailnet();
  const r = await devbox({ HOME: m.home }, ["machines", "--json", "--spoke-port", SPOKE_PORT], {
    host: m.host,
  });
  const json = JSON.parse(r.out);
  expect(json.machines.map((x: Machine) => x.spoke)).toEqual([null, null, null, null]);
  expect(json.machines.find((x: Machine) => x.name === "edge-8").vitals).toEqual(VITALS);
});
