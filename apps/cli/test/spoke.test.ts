import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { Effect } from "effect";
import { freePort } from "../src/machine/proxy.ts";
import {
  type Do,
  fingerprint,
  newNonce,
  publicKeyOf,
  type Signed,
  signRequest,
} from "../src/spoke/signed.ts";
import { makeMachine, SELF } from "./support/host.ts";
import { devbox, start } from "./support/run.ts";

const hubKey = generateKeyPairSync("ed25519").privateKey;
const strangerKey = generateKeyPairSync("ed25519").privateKey;
const KEY = publicKeyOf(hubKey);
const SET_UP = ["--data", "/srv/data", "--port", "3773", "--supervisor", "user", "--spoke"];
const PAIRING_TOKEN = "made-up-pairing-token-0123";
const PAIRING = { url: "http://edge-7.tail1234.ts.net:3773", token: PAIRING_TOKEN };

const setUpMachine = (options: { recorded?: boolean; virt?: string } = {}) => {
  const m = makeMachine();
  m.respond = (argv) => {
    if (argv[0] === "systemd-detect-virt")
      return { code: 0, stdout: `${options.virt ?? "kvm"}\n`, stderr: "" };
    if (argv[SELF.length] === "pair")
      return { code: 0, stdout: `${JSON.stringify(PAIRING)}\n`, stderr: "" };
    return undefined;
  };
  mkdirSync(join(m.home, ".config", "devbox"), { recursive: true });
  writeFileSync(
    join(m.home, ".config", "devbox", "machine.json"),
    JSON.stringify({
      name: "edge-7",
      port: 3773,
      data: "/srv/data",
      baseDir: "/srv/data/.t3",
      t3: "/srv/data/.local/bin/t3",
      ...(options.recorded === false ? {} : { up: SET_UP }),
    }),
  );
  return m;
};

const running = async (m: ReturnType<typeof makeMachine>, ...args: Array<string>) => {
  const port = await Effect.runPromise(freePort);
  const spoke = start({ HOME: m.home }, ["spoke", "--port", String(port), ...args], {
    host: m.host,
  });
  for (let i = 0; i < 100 && !spoke.err().includes("spoke:"); i += 1) await Bun.sleep(20);
  return { spoke, base: `http://127.0.0.1:${port}`, port };
};

const challenge = async (base: string) =>
  ((await (await fetch(`${base}/api/challenge`)).json()) as { nonce: string }).nonce;

const signedFor = async (base: string, key = hubKey, at = new Date(), action: Do = "update") =>
  signRequest(key, at, await challenge(base), action);

const post = async (base: string, signed?: Signed) => send(base, signed ?? (await signedFor(base)));

const send = (base: string, signed: Signed) =>
  fetch(`${base}/api/do`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed.headers },
    body: signed.body,
  });

const updates = (m: ReturnType<typeof makeMachine>) =>
  m.calls.filter((argv) => argv[0] === "<detached>");

describe("devbox spoke", async () => {
  const m = setUpMachine();
  const { spoke, base } = await running(m, "--trust", KEY);
  afterAll(() => spoke.stop());

  test("answers with what the machine is, its vitals, and the keys it trusts", async () => {
    const response = await fetch(`${base}/api/spoke`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      kind: "vm",
      vitals: m.vitals,
      trusts: [fingerprint(KEY)],
    });
    expect(m.vitalsAsked.at(-1)).toBe(m.home);
  });

  test("logs where it listens and how many keys it trusts, never a key", () => {
    expect(spoke.err()).toContain("taking requests from 1 hub key");
    expect(spoke.err()).not.toContain(KEY);
  });

  test("a request a trusted hub signed runs devbox up again with the recorded flags", async () => {
    const response = await post(base);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ asked: true });
    expect(updates(m)).toEqual([["<detached>", ...SELF, "up", ...SET_UP]]);
  });

  test("a second request while that update runs starts nothing", async () => {
    const response = await post(base);
    expect(response.status).toBe(409);
    expect(updates(m)).toHaveLength(1);
    m.processes = [];
  });

  test("hands out a new challenge to anyone who asks, without a login", async () => {
    const response = await fetch(`${base}/api/challenge`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { nonce } = (await response.json()) as { nonce: string };
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(await challenge(base)).not.toBe(nonce);
  });

  test("the same request sent again is refused", async () => {
    const signed = await signedFor(base);
    expect((await send(base, signed)).status).toBe(202);
    m.processes = [];
    const replayed = await send(base, signed);
    expect(replayed.status).toBe(403);
    expect(await replayed.json()).toEqual({
      error: "this spoke did not hand out that nonce, or already took it",
    });
    expect(updates(m)).toHaveLength(2);
  });

  test("a request with a nonce this spoke never handed out is refused", async () => {
    const response = await send(base, signRequest(hubKey, new Date(), newNonce(), "update"));
    expect(response.status).toBe(403);
    expect(updates(m)).toHaveLength(2);
  });

  test("a request from a hub it does not trust is refused", async () => {
    const response = await post(base, await signedFor(base, strangerKey));
    expect(response.status).toBe(403);
    expect(updates(m)).toHaveLength(2);
  });

  test("a request from the past is refused", async () => {
    const response = await post(
      base,
      await signedFor(base, hubKey, new Date(Date.now() - 120_000)),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "the request is too old or too new" });
  });

  test("a body longer than any signed request is refused without reading it", async () => {
    const status = await new Promise<number>((done, fail) => {
      const req = http.request(`${base}/api/do`, { method: "POST" }, (response) => {
        response.resume();
        done(response.statusCode ?? 0);
      });
      req.on("error", fail);
      req.end("x".repeat(64 * 1024));
    });
    expect(status).toBe(413);
    expect(updates(m)).toHaveLength(2);
  });

  test("a pairing request runs devbox pair here and answers with the link, which it never logs", async () => {
    const response = await post(base, await signedFor(base, hubKey, new Date(), "pair"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      url: `http://edge-7.tail1234.ts.net:3773/pair#token=${PAIRING_TOKEN}`,
    });
    expect(m.calls).toContainEqual([...SELF, "pair", "--json", "--label", "hub"]);
    expect(spoke.err()).toContain("asked for a pairing link");
    expect(spoke.err()).not.toContain(PAIRING_TOKEN);
    expect(spoke.out()).not.toContain(PAIRING_TOKEN);
    expect(updates(m)).toHaveLength(2);
  });

  test("a request for something the spoke cannot do is refused, though signed", async () => {
    const before = m.calls.length;
    for (const action of ["reboot", "constructor", "__proto__", "toString"]) {
      const response = await post(base, await signedFor(base, hubKey, new Date(), action as Do));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "this spoke does not do that" });
    }
    expect(m.calls.length).toBe(before);
  });

  test("a signed update cannot be sent as a pairing request", async () => {
    const signed = await signedFor(base);
    const response = await send(base, {
      ...signed,
      body: signed.body.replace('"do":"update"', '"do":"pair"'),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "the signature does not match" });
  });

  test("other paths are 404 and other methods are 405", async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/api/update`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/api/do`)).status).toBe(405);
    expect((await fetch(`${base}/api/spoke`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/challenge`, { method: "POST" })).status).toBe(405);
  });
});

test("a request signed for one spoke is refused by another that trusts the same hub", async () => {
  const [one, two] = [setUpMachine(), setUpMachine()];
  const [first, second] = await Promise.all([
    running(one, "--trust", KEY),
    running(two, "--trust", KEY),
  ]);
  try {
    const signed = await signedFor(first.base);
    const replayed = await send(second.base, signed);
    expect(replayed.status).toBe(403);
    expect(await replayed.json()).toEqual({
      error: "this spoke did not hand out that nonce, or already took it",
    });
    expect(updates(two)).toEqual([]);
    expect((await send(first.base, signed)).status).toBe(202);
  } finally {
    await Promise.all([first.spoke.stop(), second.spoke.stop()]);
  }
});

describe("what a spoke says it is", () => {
  const kindOf = async (m: ReturnType<typeof makeMachine>) => {
    const { spoke, base } = await running(m);
    try {
      return ((await (await fetch(`${base}/api/spoke`)).json()) as { kind: string }).kind;
    } finally {
      await spoke.stop();
    }
  };

  test("WSL, a computer, and a Mac", async () => {
    expect(await kindOf(setUpMachine({ virt: "wsl" }))).toBe("wsl");
    const bare = setUpMachine();
    bare.respond = () => undefined;
    expect(await kindOf(bare)).toBe("computer");
    const mac = makeMachine({ platform: "darwin" });
    expect(await kindOf(mac)).toBe("mac");
  });
});

test("a machine devbox up has not recorded refuses an update it cannot run", async () => {
  const m = setUpMachine({ recorded: false });
  const { spoke, base } = await running(m, "--trust", KEY);
  try {
    const response = await post(base);
    expect(response.status).toBe(409);
    expect(updates(m)).toEqual([]);
  } finally {
    await spoke.stop();
  }
});

test("a spoke that trusts nobody takes no update", async () => {
  const m = setUpMachine();
  const { spoke, base } = await running(m);
  try {
    expect(
      ((await (await fetch(`${base}/api/spoke`)).json()) as { trusts: unknown }).trusts,
    ).toEqual([]);
    expect((await post(base)).status).toBe(403);
    expect(updates(m)).toEqual([]);
  } finally {
    await spoke.stop();
  }
});

test("--trust takes only a hub key", async () => {
  const r = await devbox({ HOME: makeMachine().home }, ["spoke", "--trust", "not-a-key"]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("devbox hub key");
});

test("a pairing request devbox pair cannot answer is refused, and says nothing of what it printed", async () => {
  const m = setUpMachine();
  m.respond = (argv) =>
    argv[SELF.length] === "pair"
      ? { code: 1, stdout: "", stderr: `t3 pair printed no token ${PAIRING_TOKEN}` }
      : undefined;
  const { spoke, base } = await running(m, "--trust", KEY);
  try {
    const response = await post(base, await signedFor(base, hubKey, new Date(), "pair"));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "devbox pair gave no pairing link" });
    expect(spoke.err()).not.toContain(PAIRING_TOKEN);
  } finally {
    await spoke.stop();
  }
});
