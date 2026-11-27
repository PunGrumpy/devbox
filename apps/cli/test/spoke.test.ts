import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { Effect, Schema } from "effect";

import { freePort } from "../src/machine/proxy.ts";
import {
  fingerprint,
  KEY_HEADER,
  newNonce,
  publicKeyOf,
  SIGNATURE_HEADER,
  signRequest,
} from "../src/spoke/signed.ts";
import type { Do, Signed } from "../src/spoke/signed.ts";
import { SpokeAnswer } from "../src/spoke/vitals.ts";
import { makeMachine, SELF } from "./support/host.ts";
import { readJson } from "./support/json.ts";
import { devbox, start } from "./support/run.ts";

interface MachineRecord {
  name: string;
  port: number;
  data: string;
  baseDir: string;
  t3: string;
  up?: readonly string[];
}

const ChallengeSchema = Schema.Struct({ nonce: Schema.String });

const hubKey = generateKeyPairSync("ed25519").privateKey;
const strangerKey = generateKeyPairSync("ed25519").privateKey;
const KEY = publicKeyOf(hubKey);

const SET_UP = [
  "--data",
  "/srv/data",
  "--port",
  "3773",
  "--supervisor",
  "user",
  "--spoke",
];

const PAIRING_TOKEN = "made-up-pairing-token-0123";

const PAIRING = {
  url: "http://edge-7.tail1234.ts.net:3773",
  token: PAIRING_TOKEN,
};

const waitForSpoke = async (err: () => string, attempts = 100) => {
  if (attempts <= 0 || err().includes("spoke:")) {
    return;
  }

  await Bun.sleep(20);
  await waitForSpoke(err, attempts - 1);
};

const setUpMachine = (
  options: { recorded?: boolean; virt?: string | null } = {}
) => {
  const m = makeMachine();
  m.respond = (argv) => {
    if (argv[0] === "systemd-detect-virt" && options.virt !== null) {
      return { code: 0, stdout: `${options.virt ?? "kvm"}\n`, stderr: "" };
    }

    if (argv[SELF.length] === "pair") {
      return { code: 0, stdout: `${JSON.stringify(PAIRING)}\n`, stderr: "" };
    }
  };

  mkdirSync(path.join(m.home, ".config", "devbox"), { recursive: true });

  const record: MachineRecord = {
    name: "edge-7",
    port: 3773,
    data: "/srv/data",
    baseDir: "/srv/data/.t3",
    t3: "/srv/data/.local/bin/t3",
  };

  if (options.recorded !== false) {
    record.up = SET_UP;
  }

  writeFileSync(
    path.join(m.home, ".config", "devbox", "machine.json"),
    JSON.stringify(record)
  );

  return m;
};

const running = async (
  m: ReturnType<typeof makeMachine>,
  ...args: string[]
) => {
  const port = await Effect.runPromise(freePort);

  const spoke = start(
    { HOME: m.home },
    ["spoke", "--port", String(port), ...args],
    {
      host: m.host,
    }
  );

  await waitForSpoke(() => spoke.err());

  return { spoke, port, base: `http://127.0.0.1:${port}` };
};

const challenge = async (base: string) => {
  const response = await fetch(`${base}/api/challenge`);

  return readJson(ChallengeSchema, await response.text()).nonce;
};

const signedFor = async (
  base: string,
  key = hubKey,
  at = new Date(),
  action: Do = "update"
) => signRequest(key, at, await challenge(base), action);

const signRawAction = async (
  base: string,
  key: KeyObject,
  at: Date,
  action: string
) => {
  const body = JSON.stringify({
    at: at.toISOString(),
    nonce: await challenge(base),
    do: action,
  });

  return {
    body,
    headers: {
      [KEY_HEADER]: fingerprint(publicKeyOf(key)),
      [SIGNATURE_HEADER]: sign(null, Buffer.from(body), key).toString(
        "base64url"
      ),
    },
  } satisfies Signed;
};

const post = async (base: string, signed?: Signed) =>
  await send(base, signed ?? (await signedFor(base)));

const send = async (base: string, signed: Signed) =>
  await fetch(`${base}/api/do`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed.headers },
    body: signed.body,
  });

const updates = (m: ReturnType<typeof makeMachine>) =>
  m.calls.filter((argv) => argv[0] === "<detached>");

const readSpokeAnswer = async (base: string) => {
  const response = await fetch(`${base}/api/spoke`);

  return Schema.decodeUnknownSync(SpokeAnswer)(await response.text());
};

const kindOf = async (m: ReturnType<typeof makeMachine>) => {
  const { spoke, base } = await running(m);

  try {
    const answer = await readSpokeAnswer(base);

    return answer.kind;
  } finally {
    await spoke.stop();
  }
};

const startSpokeFixture = async () => {
  const m = setUpMachine();
  const { spoke, base } = await running(m, "--trust", KEY);

  return { m, spoke, base };
};

describe("devbox spoke", () => {
  let fixture: Awaited<ReturnType<typeof startSpokeFixture>> | undefined;

  beforeAll(async () => {
    fixture = await startSpokeFixture();
  });

  afterAll(async () => {
    if (fixture !== undefined) {
      await fixture.spoke.stop();
    }
  });

  const env = () => {
    if (fixture === undefined) {
      throw new Error("spoke fixture not initialized");
    }

    return fixture;
  };

  test("answers with what the machine is, its vitals, and the keys it trusts", async () => {
    const { m, base } = env();
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
    const { spoke } = env();
    expect(spoke.err()).toContain("taking requests from 1 hub key");
    expect(spoke.err()).not.toContain(KEY);
  });

  test("a request a trusted hub signed runs devbox up again with the recorded flags", async () => {
    const { m, base } = env();
    const response = await post(base);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ asked: true });
    expect(updates(m)).toEqual([["<detached>", ...SELF, "up", ...SET_UP]]);
  });

  test("a second request while that update runs starts nothing", async () => {
    const { m, base } = env();
    const response = await post(base);
    expect(response.status).toBe(409);
    expect(updates(m)).toHaveLength(1);
    m.processes = [];
  });

  test("hands out a new challenge to anyone who asks, without a login", async () => {
    const { base } = env();
    const response = await fetch(`${base}/api/challenge`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { nonce } = readJson(ChallengeSchema, await response.text());
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
    expect(await challenge(base)).not.toBe(nonce);
  });

  test("the same request sent again is refused", async () => {
    const { m, base } = env();
    const signed = await signedFor(base);
    const first = await send(base, signed);
    expect(first.status).toBe(202);
    m.processes = [];
    const replayed = await send(base, signed);
    expect(replayed.status).toBe(403);
    expect(await replayed.json()).toEqual({
      error: "this spoke did not hand out that nonce, or already took it",
    });
    expect(updates(m)).toHaveLength(2);
  });

  test("a request with a nonce this spoke never handed out is refused", async () => {
    const { m, base } = env();

    const response = await send(
      base,
      signRequest(hubKey, new Date(), newNonce(), "update")
    );

    expect(response.status).toBe(403);
    expect(updates(m)).toHaveLength(2);
  });

  test("a request from a hub it does not trust is refused", async () => {
    const { m, base } = env();
    const response = await post(base, await signedFor(base, strangerKey));
    expect(response.status).toBe(403);
    expect(updates(m)).toHaveLength(2);
  });

  test("a request from the past is refused", async () => {
    const { base } = env();

    const response = await post(
      base,
      await signedFor(base, hubKey, new Date(Date.now() - 120_000))
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "the request is too old or too new",
    });
  });

  test("a body longer than any signed request is refused without reading it", async () => {
    const { m, base } = env();
    const { promise, resolve, reject } = Promise.withResolvers<number>();

    const req = http.request(
      `${base}/api/do`,
      { method: "POST" },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }
    );

    req.on("error", reject);
    req.end("x".repeat(64 * 1024));
    const status = await promise;

    expect(status).toBe(413);
    expect(updates(m)).toHaveLength(2);
  });

  test("a pairing request runs devbox pair here and answers with the link, which it never logs", async () => {
    const { m, spoke, base } = env();

    const response = await post(
      base,
      await signedFor(base, hubKey, new Date(), "pair")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      url: `http://edge-7.tail1234.ts.net:3773/pair#token=${PAIRING_TOKEN}`,
    });
    expect(m.calls).toContainEqual([
      ...SELF,
      "pair",
      "--json",
      "--label",
      "hub",
    ]);
    expect(spoke.err()).toContain("asked for a pairing link");
    expect(spoke.err()).not.toContain(PAIRING_TOKEN);
    expect(spoke.out()).not.toContain(PAIRING_TOKEN);
    expect(updates(m)).toHaveLength(2);
  });

  test("a request for something the spoke cannot do is refused, though signed", async () => {
    const { m, base } = env();
    const before = m.calls.length;

    await Promise.all(
      ["reboot", "constructor", "__proto__", "toString"].map(async (action) => {
        const response = await post(
          base,
          await signRawAction(base, hubKey, new Date(), action)
        );

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "this spoke does not do that",
        });
      })
    );

    expect(m.calls).toHaveLength(before);
  });

  test("a signed update cannot be sent as a pairing request", async () => {
    const { base } = env();
    const signed = await signedFor(base);

    const response = await send(base, {
      ...signed,
      body: signed.body.replace('"do":"update"', '"do":"pair"'),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "the signature does not match",
    });
  });

  test("other paths are 404 and other methods are 405", async () => {
    const { base } = env();
    const rootRes = await fetch(`${base}/`);
    expect(rootRes.status).toBe(404);
    const updateRes = await fetch(`${base}/api/update`, { method: "POST" });
    expect(updateRes.status).toBe(404);
    const doGetRes = await fetch(`${base}/api/do`);
    expect(doGetRes.status).toBe(405);
    const spokePostRes = await fetch(`${base}/api/spoke`, { method: "POST" });
    expect(spokePostRes.status).toBe(405);

    const challengePostRes = await fetch(`${base}/api/challenge`, {
      method: "POST",
    });

    expect(challengePostRes.status).toBe(405);
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
    const accepted = await send(first.base, signed);
    expect(accepted.status).toBe(202);
  } finally {
    await Promise.all([first.spoke.stop(), second.spoke.stop()]);
  }
});

describe("what a spoke says it is", () => {
  test("WSL, a computer, and a Mac", async () => {
    expect(await kindOf(setUpMachine({ virt: "wsl" }))).toBe("wsl");
    expect(await kindOf(setUpMachine({ virt: null }))).toBe("computer");
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
    const answer = await readSpokeAnswer(base);
    expect(answer.trusts).toEqual([]);
    const response = await post(base);
    expect(response.status).toBe(403);
    expect(updates(m)).toEqual([]);
  } finally {
    await spoke.stop();
  }
});

test("--trust takes only a hub key", async () => {
  const r = await devbox({ HOME: makeMachine().home }, [
    "spoke",
    "--trust",
    "not-a-key",
  ]);

  expect(r.code).not.toBe(0);
  expect(r.err).toContain("devbox hub key");
});

test("a pairing request devbox pair cannot answer is refused, and says nothing of what it printed", async () => {
  const m = setUpMachine();
  m.respond = (argv) =>
    argv[SELF.length] === "pair"
      ? {
          code: 1,
          stdout: "",
          stderr: `t3 pair printed no token ${PAIRING_TOKEN}`,
        }
      : undefined;
  const { spoke, base } = await running(m, "--trust", KEY);

  try {
    const response = await post(
      base,
      await signedFor(base, hubKey, new Date(), "pair")
    );

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: "devbox pair gave no pairing link",
    });
    expect(spoke.err()).not.toContain(PAIRING_TOKEN);
  } finally {
    await spoke.stop();
  }
});
