import { Clock, Effect, FileSystem, Option, Schema, Semaphore } from "effect";
import { dirname, join } from "node:path";
import { type IsoTimestamp, type PostForm, postForm, renew } from "./cloudflare-oauth.ts";

export type OAuthLogin = {
  readonly kind: "oauth";
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: IsoTimestamp;
};

export type CloudflareLogin = { readonly kind: "token"; readonly token: string } | OAuthLogin;

export type CloudflareAccount = {
  readonly login: CloudflareLogin;
  readonly accountId: string;
  readonly zoneId: string;
  /** The domain, for example `example.com`. */
  readonly zone: string;
};

/** Cloudflare refused, did not answer, or its login cannot be read. The message never holds a secret. */
export class CloudflareFailed extends Schema.TaggedError<CloudflareFailed>()("CloudflareFailed", {
  message: Schema.String,
  hint: Schema.optional(Schema.String),
}) {}

export const cloudflareFile = (home: string) =>
  join(home, ".local", "state", "devbox", "cloudflare.json");

const Login = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("token"), token: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("oauth"),
    clientId: Schema.String,
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.String,
  }),
]);

const Saved = Schema.fromJsonString(
  Schema.Struct({
    login: Login,
    accountId: Schema.String,
    zoneId: Schema.String,
    zone: Schema.String,
  }),
);

const OWNER_ONLY = 0o600;

/** The saved login, or none when there is none or the file does not hold one. */
export const loadCloudflare = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(cloudflareFile(home)).pipe(Effect.option);
    return Option.flatMap(text, (t) => {
      const saved = Schema.decodeUnknownOption(Saved)(t);
      return Option.map(saved, (account): CloudflareAccount => account);
    });
  });

/** Writes the login for this user alone, so no reader ever sees a half written or open file. */
export const saveCloudflare = (home: string, account: CloudflareAccount) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = cloudflareFile(home);
    const temporary = `${path}.tmp`;
    yield* fs.makeDirectory(dirname(path), { recursive: true });
    yield* fs.remove(temporary, { force: true });
    yield* fs.writeFileString(temporary, `${JSON.stringify(account, null, 2)}\n`, {
      flag: "wx",
      mode: OWNER_ONLY,
    });
    yield* fs.chmod(temporary, OWNER_ONLY);
    yield* fs.rename(temporary, path);
  }).pipe(
    Effect.mapError(
      () => new CloudflareFailed({ message: `cannot write ${cloudflareFile(home)}` }),
    ),
  );

/** Deletes the saved login. Whether there was one to delete. */
export const forgetCloudflare = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = cloudflareFile(home);
    if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) return false;
    yield* fs
      .remove(path)
      .pipe(Effect.mapError(() => new CloudflareFailed({ message: `cannot delete ${path}` })));
    return true;
  });

const RENEW_BEFORE_MS = 5 * 60 * 1000;

const fresh = (login: OAuthLogin, now: number) =>
  Date.parse(login.expiresAt) - now > RENEW_BEFORE_MS;

const renewing = Semaphore.makeUnsafe(1);

/**
 * The bearer to call Cloudflare with. An OAuth login close to its end is renewed with `post` and
 * saved first. A refusal says to sign in again, and never holds a token.
 */
export const bearerOf = (home: string, account: CloudflareAccount, post: PostForm = postForm) =>
  Effect.gen(function* () {
    const { login } = account;
    if (login.kind === "token") return login.token;
    if (fresh(login, yield* Clock.currentTimeMillis)) return login.accessToken;
    return yield* renewing.withPermits(1)(
      Effect.gen(function* () {
        const saved = Option.getOrElse(yield* loadCloudflare(home), () => account);
        const current = saved.login;
        if (current.kind === "token") return current.token;
        if (fresh(current, yield* Clock.currentTimeMillis)) return current.accessToken;
        const tokens = yield* renew(post, current).pipe(
          Effect.mapError(
            (error) =>
              new CloudflareFailed({
                message:
                  error.hint === undefined ? error.message : `${error.message}; ${error.hint}`,
              }),
          ),
        );
        yield* saveCloudflare(home, { ...saved, login: { ...current, ...tokens } });
        return tokens.accessToken;
      }),
    );
  });
