import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";

import { Schema } from "effect";

import {
  fingerprint,
  handOut,
  KEY_HEADER,
  SIGNATURE_HEADER,
  MAX_CHALLENGES,
  PublicKey,
  publicKeyOf,
  signRequest,
  verifyRequest,
  WINDOW_MS,
} from "../src/spoke/signed.ts";
import type { Challenges } from "../src/spoke/signed.ts";
import { vitalsOf } from "../src/spoke/vitals.ts";

const hub = generateKeyPairSync("ed25519").privateKey;
const other = generateKeyPairSync("ed25519").privateKey;
const KEY = publicKeyOf(hub);
const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const NONCE = "nonce-0123456789abcdef";

const request = (
  signed = signRequest(hub, new Date(NOW), NONCE, "update")
) => ({
  body: signed.body,
  key: signed.headers["x-devbox-key"],
  signature: signed.headers["x-devbox-signature"],
});

type Request = {
  body: string;
  key: string | undefined;
  signature: string | undefined;
};

const handedOut = handOut(new Map(), NONCE, NOW);

const verdict = (r: Request, challenges: Challenges = handedOut, now = NOW) =>
  verifyRequest(r, [KEY], now, challenges);

const nonceNumber = (n: number) => `nonce-${String(n).padStart(16, "0")}`;

describe("a signed request", () => {
  test("names the key by the base64url SHA-256 of its raw bytes", () => {
    const r = request();
    expect(r.body).toBe(
      `{"at":"2026-11-27T12:00:00.000Z","nonce":"${NONCE}","do":"update"}`
    );
    expect(r.key).toBe(fingerprint(KEY));
    expect(r.key).toBe(
      new Bun.CryptoHasher("sha256")
        .update(Buffer.from(KEY, "base64url"))
        .digest("base64url")
    );
    expect(KEY).toHaveLength(43);
  });

  test("is taken once when its nonce is one the spoke handed out, and says what it asks for", () => {
    const first = verdict(request());
    expect(first.ok).toBe(true);

    if (!first.ok) {
      return;
    }

    expect(first.do).toBe("update");
    expect(verdict(request(), first.challenges)).toEqual({
      ok: false,
      why: "this spoke did not hand out that nonce, or already took it",
    });
  });

  test("is refused, though signed by a trusted hub, when this spoke never handed out its nonce", () => {
    const elsewhere = handOut(new Map(), "nonce-fedcba9876543210", NOW);
    expect(verdict(request(), elsewhere)).toEqual({
      ok: false,
      why: "this spoke did not hand out that nonce, or already took it",
    });
    expect(verdict(request(), new Map()).ok).toBe(false);
  });

  test("is refused when the spoke handed out its nonce longer ago than the window", () => {
    const old = handOut(new Map(), NONCE, NOW - WINDOW_MS - 1);
    expect(verdict(request(), old)).toEqual({
      ok: false,
      why: "the challenge is too old",
    });
    expect(
      verdict(request(), handOut(new Map(), NONCE, NOW - WINDOW_MS)).ok
    ).toBe(true);
  });

  test("is taken at the edge of the window, on either side", () => {
    expect(verdict(request(), handedOut, NOW + WINDOW_MS).ok).toBe(true);
    expect(verdict(request(), handedOut, NOW - WINDOW_MS).ok).toBe(true);
  });

  test("is refused when signed by a key the spoke does not trust", () => {
    expect(
      verdict(request(signRequest(other, new Date(NOW), NONCE, "update")))
    ).toEqual({
      ok: false,
      why: "this spoke does not trust that key",
    });
  });

  test("is refused when another key's signature is sent under the trusted key's name", () => {
    const forged = {
      ...request(signRequest(other, new Date(NOW), NONCE, "update")),
      key: fingerprint(KEY),
    };

    expect(verdict(forged)).toEqual({
      ok: false,
      why: "the signature does not match",
    });
  });

  test("is refused when its body was changed after signing", () => {
    const r = request();
    expect(
      verdict({ ...r, body: r.body.replace("12:00:00", "12:00:01") })
    ).toEqual({
      ok: false,
      why: "the signature does not match",
    });
    expect(verdict({ ...r, body: `${r.body} ` }).ok).toBe(false);
  });

  test("signed for an update, cannot be sent as a pairing request, because the action is signed", () => {
    const r = request();

    const asPair = {
      ...r,
      body: r.body.replace('"do":"update"', '"do":"pair"'),
    };

    expect(asPair.body).toContain('"do":"pair"');
    expect(verdict(asPair)).toEqual({
      ok: false,
      why: "the signature does not match",
    });
  });

  test("says what it asks for, a name the spoke has yet to look up", () => {
    const pair = verdict(
      request(signRequest(hub, new Date(NOW), NONCE, "pair"))
    );

    expect(pair.ok && pair.do).toBe("pair");
  });

  test("is refused without a signature, or with one that is not base64url", () => {
    expect(verdict({ ...request(), signature: undefined }).ok).toBe(false);
    expect(verdict({ ...request(), signature: "!!!" }).ok).toBe(false);
    expect(verdict({ ...request(), key: undefined }).ok).toBe(false);
  });

  test("is refused once it is older or newer than the window", () => {
    const stale = {
      ok: false,
      why: "the request is too old or too new",
    } as const;

    expect(verdict(request(), handedOut, NOW + WINDOW_MS + 1)).toEqual(stale);
    expect(verdict(request(), handedOut, NOW - WINDOW_MS - 1)).toEqual(stale);
  });

  test("is refused when it names no time, a nonce that is too short, or nothing to do", () => {
    const bad = (
      at: string,
      nonce: string,
      rest: object = { do: "update" }
    ) => {
      const signed = signRequest(hub, new Date(NOW), NONCE, "update");
      const body = JSON.stringify({ at, nonce, ...rest });
      const signature = sign(null, Buffer.from(body), hub);

      return verdict({
        body,
        key: signed.headers["x-devbox-key"],
        signature: signature.toString("base64url"),
      });
    };

    expect(bad("yesterday", NONCE)).toEqual({
      ok: false,
      why: "the request is too old or too new",
    });

    const shapeless = {
      ok: false,
      why: "the body is not a signed request",
    } as const;

    expect(bad(new Date(NOW).toISOString(), "short")).toEqual(shapeless);
    expect(bad(new Date(NOW).toISOString(), NONCE, {})).toEqual(shapeless);
    expect(bad(new Date(NOW).toISOString(), NONCE, { do: 7 })).toEqual(
      shapeless
    );
  });
});

describe("the challenges a spoke hands out", () => {
  test("forget a nonce once it has left the window", () => {
    const later = handOut(
      handedOut,
      "nonce-fedcba9876543210",
      NOW + 2 * WINDOW_MS
    );

    expect([...later.keys()]).toEqual(["nonce-fedcba9876543210"]);
  });

  test(`keep at most ${MAX_CHALLENGES}, so the 65th drops the oldest`, () => {
    let challenges: Challenges = new Map();

    for (let n = 1; n <= MAX_CHALLENGES + 1; n += 1) {
      challenges = handOut(challenges, nonceNumber(n), NOW);
    }

    expect(challenges.size).toBe(MAX_CHALLENGES);

    const answering = (nonce: string) =>
      verdict(
        request(signRequest(hub, new Date(NOW), nonce, "update")),
        challenges
      ).ok;

    expect(answering(nonceNumber(1))).toBe(false);
    expect(answering(nonceNumber(2))).toBe(true);
    expect(answering(nonceNumber(MAX_CHALLENGES + 1))).toBe(true);
  });
});

describe("a hub key on the command line", () => {
  const valid = (text: string) => Schema.is(PublicKey)(text);

  test("is the 32 raw bytes of an Ed25519 key in base64url", () => {
    expect(valid(KEY)).toBe(true);
    expect(valid(`${KEY}=`)).toBe(false);
    expect(valid(KEY.slice(1))).toBe(false);
    expect(valid(Buffer.alloc(32).toString("base64"))).toBe(false);
    expect(valid("--hub")).toBe(false);
  });
});

describe("vitals", () => {
  test("load is per core, memory in use is what is not available, disk counts its blocks", () => {
    expect(
      vitalsOf({
        load1: 3,
        cores: 8,
        memory: { total: 16_000, available: 4_000 },
        disk: { blocks: 1000, free: 250, blockSize: 4096 },
      })
    ).toEqual({
      load: 0.375,
      memory: { used: 12_000, total: 16_000 },
      disk: { used: 750 * 4096, total: 1000 * 4096 },
    });
  });

  test("a machine that reports no cores has no load rather than infinite load", () => {
    const v = vitalsOf({
      load1: 1,
      cores: 0,
      memory: { total: 1, available: 2 },
      disk: { blocks: 0, free: 0, blockSize: 4096 },
    });

    expect(v.load).toBe(0);
    expect(v.memory.used).toBe(0);
  });

  test("carries the fields an action needs inside the signed bytes", () => {
    const signed = signRequest(hub, new Date(NOW), NONCE, "tunnel", {
      token: "run-token",
      url: "https://t3-edge-7.example.com",
    });

    const taken = verifyRequest(
      {
        body: signed.body,
        key: signed.headers[KEY_HEADER],
        signature: signed.headers[SIGNATURE_HEADER],
      },
      [KEY],
      NOW,
      handOut(new Map(), NONCE, NOW)
    );

    expect(taken).toMatchObject({
      ok: true,
      do: "tunnel",
      fields: { token: "run-token", url: "https://t3-edge-7.example.com" },
    });

    const changed = verifyRequest(
      {
        body: signed.body.replace("t3-edge-7", "t3-edge-8"),
        key: signed.headers[KEY_HEADER],
        signature: signed.headers[SIGNATURE_HEADER],
      },
      [KEY],
      NOW,
      handOut(new Map(), NONCE, NOW)
    );

    expect(changed).toEqual({ ok: false, why: "the signature does not match" });
  });
});
