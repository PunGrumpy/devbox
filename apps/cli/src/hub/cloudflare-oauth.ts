import { createHash, randomBytes } from "node:crypto";

import { DateTime, Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";

import { Output, plural } from "../output.ts";
import { listen } from "./listen.ts";

export type IsoTimestamp = string;

/** What a Cloudflare OAuth login holds. None of it is ever printed or logged. */
export type OAuthTokens = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: IsoTimestamp;
};

export class OAuthFailed extends Schema.TaggedError<OAuthFailed>()(
  "OAuthFailed",
  {
    message: Schema.String,
    hint: Schema.optional(Schema.String),
  }
) {}

export type Endpoints = { readonly authorize: string; readonly token: string };

/** From https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/ */
export const CLOUDFLARE: Endpoints = {
  authorize: "https://dash.cloudflare.com/oauth2/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
};

/**
 * What the hub asks Cloudflare for: zones to choose from, DNS records, tunnels and the zone's WAF
 * rules, and `offline_access` for a refresh token. The client must be registered with the same
 * scopes and with the `refresh_token` grant.
 */
export const SCOPES = [
  "zone.read",
  "dns.write",
  "argotunnel.write",
  "zone-waf.write",
  "offline_access",
] as const;

/** The one port Cloudflare sends the browser back to, so the client registers one exact address. */
export const CALLBACK_PORT = 3783;

export const redirectUri = (port: number) =>
  `http://127.0.0.1:${port}/callback`;

const randomText = () => randomBytes(32).toString("base64url");

/** The S256 challenge for a PKCE verifier (RFC 7636). */
export const challengeOf = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

export type Pkce = { readonly verifier: string; readonly challenge: string };

/** A new verifier, 43 characters of base64url, and its challenge. */
export const makePkce = (): Pkce => {
  const verifier = randomText();

  return { verifier, challenge: challengeOf(verifier) };
};

/** The state that ties Cloudflare's answer to this login. */
export const makeState = randomText;

/** The address the owner opens to sign in. It carries the challenge, never the verifier. */
export const authorizeUrl = (request: {
  readonly authorize: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string;
}): string => {
  const url = new URL(request.authorize);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: SCOPES.join(" "),
    state: request.state,
    code_challenge: request.challenge,
    code_challenge_method: "S256",
  }).toString();

  return url.href;
};

const ERROR_CODE = /^[a-z_]{1,64}$/;

const printableVendorCodeOrPlaceholder = (value: string | null | undefined) =>
  value !== null && value !== undefined && ERROR_CODE.test(value)
    ? value
    : "an unnamed error";

export type Callback =
  | { readonly _tag: "Code"; readonly code: string }
  | {
      readonly _tag: "Refused";
      readonly message: string;
      readonly hint: string;
    };

const AGAIN = "run the login again";

/** What the browser brought back, read from the callback's path and query. */
export const readCallback = (url: string, state: string): Callback => {
  const query = new URL(url, "http://127.0.0.1").searchParams;

  if (query.get("state") !== state) {
    return {
      _tag: "Refused",
      message:
        "the answer did not come from this login, its state does not match",
      hint: AGAIN,
    };
  }

  const error = query.get("error");

  if (error !== null) {
    return {
      _tag: "Refused",
      message: `Cloudflare did not sign the hub in: ${printableVendorCodeOrPlaceholder(error)}`,
      hint:
        error === "access_denied"
          ? `${AGAIN} and select Authorize`
          : "check the client's redirect URL and scopes in the Cloudflare dashboard",
    };
  }

  const code = query.get("code");

  if (code === null || code === "") {
    return {
      _tag: "Refused",
      message: "Cloudflare's answer has no code",
      hint: AGAIN,
    };
  }

  return { _tag: "Code", code };
};

// Cloudflare's documentation does not say how long an access token lasts. When it names no
// lifetime, the login is renewed after five minutes rather than used past its end.
const ASSUMED_SECONDS = 300;

const TokenAnswer = Schema.fromJsonString(
  Schema.Struct({
    access_token: Schema.NonEmptyString,
    token_type: Schema.String,
    expires_in: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
    refresh_token: Schema.optional(Schema.NonEmptyString),
  })
);

/**
 * The tokens in a token endpoint's answer, given the time it came. A renewal that brings no new
 * refresh token keeps `refreshToken`. None when the answer is not a bearer token with one.
 */
export const parseTokens = (
  body: string,
  now: number,
  refreshToken?: string
): Option.Option<OAuthTokens> =>
  Option.flatMap(Schema.decodeUnknownOption(TokenAnswer)(body), (answer) => {
    const refresh = answer.refresh_token ?? refreshToken;

    if (answer.token_type.toLowerCase() !== "bearer" || refresh === undefined) {
      return Option.none();
    }

    const seconds = answer.expires_in ?? ASSUMED_SECONDS;

    return Option.some({
      accessToken: answer.access_token,
      refreshToken: refresh,
      expiresAt: new Date(now + seconds * 1000).toISOString(),
    });
  });

export type Answer = { readonly status: number; readonly body: string };

/** Sends a form to a token endpoint. The one function that talks to Cloudflare, so tests replace it. */
export type PostForm = (
  url: string,
  form: Readonly<Record<string, string>>
) => Effect.Effect<Answer, OAuthFailed>;

const MAX_ANSWER = 65_536;

export const postForm: PostForm = (url, form) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { accept: "application/json" },
        body: new URLSearchParams(form),
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });

      const body = await response.text();

      return {
        status: response.status,
        body: body.length > MAX_ANSWER ? "" : body,
      };
    },
    catch: () =>
      new OAuthFailed({
        message: `cannot reach ${new URL(url).host}`,
        hint: "check this machine's internet connection",
      }),
  });

const ErrorAnswer = Schema.fromJsonString(
  Schema.Struct({ error: Schema.String })
);

const refusal = (body: string) =>
  printableVendorCodeOrPlaceholder(
    Option.getOrUndefined(Schema.decodeUnknownOption(ErrorAnswer)(body))?.error
  );

const tokensFrom = (
  answer: Answer,
  failed: { readonly refused: string; readonly hint: string },
  refreshToken?: string
) =>
  Effect.gen(function* () {
    if (answer.status < 200 || answer.status > 299) {
      return yield* new OAuthFailed({
        message: `${failed.refused} (${answer.status}, ${refusal(answer.body)})`,
        hint: failed.hint,
      });
    }

    const now = DateTime.toEpochMillis(yield* DateTime.now);

    return yield* Option.match(parseTokens(answer.body, now, refreshToken), {
      onNone: () =>
        Effect.fail(
          new OAuthFailed({
            message:
              "Cloudflare's token answer is not a bearer token with a refresh token",
            hint: "give the OAuth client the refresh_token grant, then sign in again",
          })
        ),
      onSome: Effect.succeed,
    });
  });

/** Trades the code from the callback, with the verifier only this login knows, for tokens. */
export const exchange = (
  post: PostForm,
  request: {
    readonly token: string;
    readonly clientId: string;
    readonly code: string;
    readonly verifier: string;
    readonly redirectUri: string;
  }
) =>
  Effect.flatMap(
    post(request.token, {
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: request.redirectUri,
      client_id: request.clientId,
      code_verifier: request.verifier,
    }),
    (answer) =>
      tokensFrom(answer, {
        refused: "Cloudflare did not take the sign-in code",
        hint: AGAIN,
      })
  );

/** New tokens for a login close to its end. A refusal means the owner signs in again. */
export const renew = (
  post: PostForm,
  login: { readonly clientId: string; readonly refreshToken: string },
  token = CLOUDFLARE.token
) =>
  Effect.flatMap(
    post(token, {
      grant_type: "refresh_token",
      refresh_token: login.refreshToken,
      client_id: login.clientId,
    }),
    (answer) =>
      tokensFrom(
        answer,
        {
          refused: "Cloudflare refused to renew the hub's login",
          hint: `sign in again with \`devbox hub cloudflare login --client-id ${login.clientId}\``,
        },
        login.refreshToken
      )
  );

const PAGE = {
  took: "devbox has what it needs. Go back to the terminal; you can close this tab.\n",
  refused:
    "devbox did not get a sign-in. The terminal says why; you can close this tab.\n",
};

const callbackListener = (port: number, state: string) =>
  Effect.gen(function* () {
    const { promise: arrived, resolve: arrive } =
      Promise.withResolvers<Callback>();

    let taken = false;
    yield* listen("127.0.0.1", port, (req, res) => {
      const url = req.url ?? "/";
      const { pathname } = new URL(url, "http://127.0.0.1");

      if (taken || req.method !== "GET" || pathname !== "/callback") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found\n");

        return;
      }

      taken = true;
      const callback = readCallback(url, state);
      res.on("close", () => arrive(callback));
      res.writeHead(callback._tag === "Code" ? 200 : 400, {
        "cache-control": "no-store",
        connection: "close",
        "content-type": "text/plain; charset=utf-8",
        "referrer-policy": "no-referrer",
      });
      res.end(callback._tag === "Code" ? PAGE.took : PAGE.refused);
    }).pipe(
      Effect.mapError(
        () =>
          new OAuthFailed({
            message: `cannot listen on 127.0.0.1:${port} for Cloudflare's answer`,
            hint: `stop what uses port ${port}, then sign in again`,
          })
      )
    );

    return Effect.promise(() => arrived);
  });

/** Where the login talks to and how long it waits. Tests point it at a fake Cloudflare. */
export type Flow = {
  readonly endpoints: Endpoints;
  readonly port: number;
  readonly waitMs: number;
  readonly post: PostForm;
};

export const CLOUDFLARE_FLOW: Flow = {
  endpoints: CLOUDFLARE,
  port: CALLBACK_PORT,
  waitMs: 300_000,
  post: postForm,
};

/** Signs the hub in through the owner's browser, and the tokens it got. */
export const signIn = (clientId: string, flow: Flow = CLOUDFLARE_FLOW) =>
  Effect.gen(function* () {
    const out = yield* Output;
    const pkce = makePkce();
    const state = makeState();
    const redirect = redirectUri(flow.port);

    const callback = yield* Effect.scoped(
      Effect.gen(function* () {
        const arrived = yield* callbackListener(flow.port, state);
        yield* out.line(
          "Open this address in a browser on this machine and select Authorize:"
        );
        yield* out.line();
        yield* out.line(
          `  ${authorizeUrl({ authorize: flow.endpoints.authorize, clientId, redirectUri: redirect, challenge: pkce.challenge, state })}`
        );
        yield* out.line();
        yield* out.log(
          `from another computer, forward the port first: ssh -L ${flow.port}:127.0.0.1:${flow.port} <this machine>`
        );

        return yield* arrived.pipe(Effect.timeoutOption(flow.waitMs));
      })
    );

    if (Option.isNone(callback)) {
      return yield* new OAuthFailed({
        message: `no answer from Cloudflare within ${
          flow.waitMs >= 60_000
            ? plural(Math.round(flow.waitMs / 60_000), "minute")
            : plural(Math.ceil(flow.waitMs / 1000), "second")
        }`,
        hint: AGAIN,
      });
    }

    if (callback.value._tag === "Refused") {
      return yield* new OAuthFailed({
        message: callback.value.message,
        hint: callback.value.hint,
      });
    }

    return yield* exchange(flow.post, {
      token: flow.endpoints.token,
      clientId,
      code: callback.value.code,
      verifier: pkce.verifier,
      redirectUri: redirect,
    });
  });

/** What the login hands on to be saved. */
export type SignedIn = {
  readonly clientId: string;
  readonly tokens: OAuthTokens;
  readonly account: Option.Option<string>;
  readonly zone: Option.Option<string>;
};

const ClientId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[\w.~-]{1,200}$/))
);

/** `devbox hub cloudflare login`: signs the hub in with OAuth and hands the result to `save`. */
export const loginCommand = <E, R>(
  save: (signedIn: SignedIn) => Effect.Effect<void, E, R>,
  flow: Flow = CLOUDFLARE_FLOW
) =>
  Command.make(
    "login",
    {
      clientId: Flag.String("client-id").pipe(
        Flag.withDescription(
          "the OAuth client's ID from Manage Account > OAuth clients"
        ),
        Flag.withSchema(ClientId)
      ),
      account: Flag.String("account").pipe(
        Flag.withDescription(
          "the account ID, when the login sees more than one"
        ),
        Flag.optional
      ),
      zone: Flag.String("zone").pipe(
        Flag.withDescription("the domain, when the login sees more than one"),
        Flag.optional
      ),
    },
    ({ clientId, account, zone }) =>
      Effect.gen(function* () {
        const out = yield* Output;
        const tokens = yield* signIn(clientId, flow);
        yield* save({ clientId, tokens, account, zone });
        yield* out.success("the hub is signed in to Cloudflare");
      })
  ).pipe(
    Command.withDescription(
      "Sign the hub in to Cloudflare in a browser, with an OAuth client that uses PKCE"
    )
  );
