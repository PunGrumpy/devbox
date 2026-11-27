import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import path from "node:path";

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

const stateDir = (home: string) => path.join(home, ".local", "state", "devbox");
export const keyFile = (home: string) => path.join(stateDir(home), "hub-key");

export const tokenFile = (home: string) =>
  path.join(stateDir(home), "hub-token");

const OWNER_ONLY = 0o600;

const createUnlessAnotherProcessJustDid = (file: string, make: () => string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs
      .writeFileString(file, make(), { flag: "wx", mode: OWNER_ONLY })
      .pipe(Effect.ignore);

    return yield* fs.readFileString(file);
  });

const ownFile = (file: string, make: () => string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const existing = yield* fs.readFileString(file).pipe(Effect.option);

    if (Option.isSome(existing)) {
      yield* fs.chmod(file, OWNER_ONLY).pipe(Effect.ignore);

      return existing.value;
    }

    return yield* createUnlessAnotherProcessJustDid(file, make);
  }).pipe(
    Effect.mapError(
      () => new SecretFailed({ message: `cannot read or create ${file}` })
    )
  );

const remakeHint = (file: string) =>
  `move ${file} aside and start the hub again to make a new one`;

export interface HubSecrets {
  readonly privateKey: KeyObject;
  /** Public, base64url. */
  readonly key: string;
  readonly fingerprint: string;
  readonly token: string;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export const hubKey = (home: string) =>
  Effect.gen(function* () {
    const file = keyFile(home);

    const pem = yield* ownFile(file, () =>
      generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8",
      })
    );

    const privateKey = yield* Effect.try({
      try: () => createPrivateKey(pem),
      catch: () =>
        new SecretFailed({
          message: `${file} does not hold an Ed25519 key`,
          hint: `${remakeHint(file)}. Every spoke then needs the new key`,
        }),
    });

    if (privateKey.asymmetricKeyType !== "ed25519") {
      return yield* new SecretFailed({
        message: `${file} does not hold an Ed25519 key`,
        hint: remakeHint(file),
      });
    }

    return privateKey;
  });

export const hubToken = (home: string) =>
  Effect.gen(function* () {
    const file = tokenFile(home);

    const token = (yield* ownFile(
      file,
      () => `${randomBytes(32).toString("base64url")}\n`
    )).trim();

    if (!TOKEN.test(token)) {
      return yield* new SecretFailed({
        message: `${file} does not hold a hub token`,
        hint: remakeHint(file),
      });
    }

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
