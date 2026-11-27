import {
  createHash,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

import { Option, Schema } from "effect";

export const WINDOW_MS = 60_000;

const isRawKey = (text: string) =>
  /^[A-Za-z0-9_-]{43}$/u.test(text) &&
  Buffer.from(text, "base64url").toString("base64url") === text;

/** An Ed25519 public key, its 32 raw bytes in base64url. */
export const PublicKey = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(isRawKey, {
      message: "expected a hub key, the line `devbox hub key` prints",
    })
  )
);

/** The base64url SHA-256 of a key's raw bytes. */
export const fingerprint = (publicKey: string) =>
  createHash("sha256")
    .update(Buffer.from(publicKey, "base64url"))
    .digest("base64url");

export const publicKeyOf = (privateKey: KeyObject) =>
  String(createPublicKey(privateKey).export({ format: "jwk" }).x);

export const newNonce = () => randomBytes(18).toString("base64url");

export const KEY_HEADER = "x-devbox-key";
export const SIGNATURE_HEADER = "x-devbox-signature";

export interface Signed {
  readonly body: string;
  readonly headers: Readonly<
    Record<typeof KEY_HEADER | typeof SIGNATURE_HEADER, string>
  >;
}

/** What a hub may ask a spoke to do. A spoke does only the ones it has an entry for. */
export type Do = "update" | "pair" | "tunnel" | "untunnel";

/** What an action needs besides its name. A tunnel sends its run token and the address it serves. */
export interface Fields {
  readonly token?: string;
  readonly url?: string;
}

/**
 * The request a hub sends a spoke, signed over the exact bytes of its body. What it asks for is in
 * those bytes, so a signature for one action cannot be used for another.
 */
export const signRequest = (
  privateKey: KeyObject,
  at: Date,
  nonce: string,
  action: Do,
  fields: Fields = {}
) => {
  const body = JSON.stringify({
    ...fields,
    at: at.toISOString(),
    nonce,
    do: action,
  });

  return {
    body,
    headers: {
      [KEY_HEADER]: fingerprint(publicKeyOf(privateKey)),
      [SIGNATURE_HEADER]: sign(null, Buffer.from(body), privateKey).toString(
        "base64url"
      ),
    },
  } satisfies Signed;
};

export const Nonce = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,128}$/u))
);

const Body = Schema.fromJsonString(
  Schema.Struct({
    at: Schema.String,
    nonce: Nonce,
    do: Schema.String,
    token: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
  })
);

export const MAX_CHALLENGES = 64;

/** Each nonce a spoke handed out and has not taken, with when, oldest first. */
export type Challenges = ReadonlyMap<string, number>;

const open = (challenges: Challenges, now: number) =>
  [...challenges].filter(([, time]) => time >= now - WINDOW_MS);

/** The challenges once `nonce` is handed out at `now`, without the oldest past the limit. */
export const handOut = (challenges: Challenges, nonce: string, now: number) =>
  new Map(
    [...open(challenges, now), [nonce, now] as const].slice(-MAX_CHALLENGES)
  );

export type Verdict =
  | {
      readonly ok: true;
      readonly challenges: Challenges;
      /** What the request asks for, which the spoke has not yet checked it can do. */
      readonly do: string;
      readonly fields: Fields;
    }
  | { readonly ok: false; readonly why: string };

const refuse = (why: string) => ({ ok: false, why }) satisfies Verdict;

const verifies = (publicKey: string, body: string, signature: string) => {
  try {
    return verify(
      null,
      Buffer.from(body),
      createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: publicKey },
        format: "jwk",
      }),
      Buffer.from(signature, "base64url")
    );
  } catch {
    return false;
  }
};

/**
 * Whether a spoke that trusts `trusted` takes this request at `now`. A request answers one challenge
 * this spoke handed out, and taking it closes that challenge, so it is taken once and by this spoke
 * alone.
 */
export const verifyRequest = (
  request: {
    readonly body: string;
    readonly key: string | undefined;
    readonly signature: string | undefined;
  },
  trusted: readonly string[],
  now: number,
  challenges: Challenges
) => {
  const publicKey = trusted.find((key) => fingerprint(key) === request.key);

  if (publicKey === undefined) {
    return refuse("this spoke does not trust that key");
  }

  if (
    request.signature === undefined ||
    !verifies(publicKey, request.body, request.signature)
  ) {
    return refuse("the signature does not match");
  }

  const body = Schema.decodeUnknownOption(Body)(request.body);

  if (Option.isNone(body)) {
    return refuse("the body is not a signed request");
  }

  const at = Date.parse(body.value.at);

  if (Number.isNaN(at) || Math.abs(now - at) > WINDOW_MS) {
    return refuse("the request is too old or too new");
  }

  const handedOut = challenges.get(body.value.nonce);

  if (handedOut === undefined) {
    return refuse("this spoke did not hand out that nonce, or already took it");
  }

  if (handedOut < now - WINDOW_MS) {
    return refuse("the challenge is too old");
  }

  const { token, url } = body.value;
  const withToken: Fields = token === undefined ? {} : { token };
  const fields: Fields = url === undefined ? withToken : { ...withToken, url };

  return {
    ok: true,
    challenges: new Map(
      open(challenges, now).filter(([nonce]) => nonce !== body.value.nonce)
    ),
    do: body.value.do,
    fields,
  } satisfies Verdict;
};
