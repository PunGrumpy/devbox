import {
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { dirname, join } from "node:path";

import { Effect, FileSystem, Option, Schema } from "effect";
import { Command } from "effect/cli";

import { Locations } from "../migrate/locations.ts";
import { Output } from "../output.ts";
import { fingerprint, publicKeyOf } from "../spoke/signed.ts";

export class SecretFailed extends Schema.TaggedError<SecretFailed>()(
  "SecretFailed",
  {
    message: Schema.String,
    hint: Schema.optional(Schema.String),
  }
) {}

const stateDir = (home: string) => join(home, ".local", "state", "devbox");
export const keyFile = (home: string) => join(stateDir(home), "hub-key");
export const tokenFile = (home: string) => join(stateDir(home), "hub-token");

const OWNER_ONLY = 0o600;

const createUnlessAnotherProcessJustDid = (path: string, make: () => string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(path), { recursive: true });
    yield* fs
      .writeFileString(path, make(), { flag: "wx", mode: OWNER_ONLY })
      .pipe(Effect.ignore);
    return yield* fs.readFileString(path);
  });

const ownFile = (path: string, make: () => string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const existing = yield* fs.readFileString(path).pipe(Effect.option);
    if (Option.isSome(existing)) {
      yield* fs.chmod(path, OWNER_ONLY).pipe(Effect.ignore);
      return existing.value;
    }
    return yield* createUnlessAnotherProcessJustDid(path, make);
  }).pipe(
    Effect.mapError(
      () => new SecretFailed({ message: `cannot read or create ${path}` })
    )
  );

const remakeHint = (path: string) =>
  `move ${path} aside and start the hub again to make a new one`;

export type HubSecrets = {
  readonly privateKey: KeyObject;
  /** Public, base64url. */
  readonly key: string;
  readonly fingerprint: string;
  readonly token: string;
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const hubKey = (home: string) =>
  Effect.gen(function* () {
    const path = keyFile(home);
    const pem = yield* ownFile(path, () =>
      generateKeyPairSync("ed25519")
        .privateKey.export({ format: "pem", type: "pkcs8" })
        .toString()
    );
    const privateKey = yield* Effect.try({
      try: () => createPrivateKey(pem),
      catch: () =>
        new SecretFailed({
          message: `${path} does not hold an Ed25519 key`,
          hint: `${remakeHint(path)}. Every spoke then needs the new key`,
        }),
    });
    if (privateKey.asymmetricKeyType !== "ed25519")
      return yield* new SecretFailed({
        message: `${path} does not hold an Ed25519 key`,
        hint: remakeHint(path),
      });
    return privateKey;
  });

export const hubToken = (home: string) =>
  Effect.gen(function* () {
    const path = tokenFile(home);
    const token = (yield* ownFile(
      path,
      () => `${randomBytes(32).toString("base64url")}\n`
    )).trim();
    if (!TOKEN.test(token))
      return yield* new SecretFailed({
        message: `${path} does not hold a hub token`,
        hint: remakeHint(path),
      });
    return token;
  });

export const hubSecrets = (home: string) =>
  Effect.gen(function* () {
    const privateKey = yield* hubKey(home);
    const key = publicKeyOf(privateKey);
    const secrets: HubSecrets = {
      privateKey,
      key,
      fingerprint: fingerprint(key),
      token: yield* hubToken(home),
    };
    return secrets;
  });

export const keyCommand = Command.make("key", {}, () =>
  Effect.gen(function* () {
    const out = yield* Output;
    const key = publicKeyOf(yield* hubKey((yield* Locations).home));
    yield* out.stdout(`${key}\n`);
  })
).pipe(
  Command.withDescription(
    "Print the hub's public key, which `devbox up --spoke --trust <key>` on a machine trusts"
  )
);

export const tokenCommand = Command.make("token", {}, () =>
  Effect.gen(function* () {
    const out = yield* Output;
    yield* out.stdout(`${yield* hubToken((yield* Locations).home)}\n`);
  })
).pipe(
  Command.withDescription(
    "Print the token the hub page asks for before it updates a machine"
  )
);
