import { Option, Schema } from "effect";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** A request as the hub reads it, with header names in lower case. */
export type HubRequest = {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The body, empty when the hub did not read it, or null when it was longer than the hub reads. */
  readonly body: string | null;
};

export type Reply = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
};

export const COOKIE = "devbox_hub";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const MAX_LOGIN_BYTES = 1024;

export const json = (
  status: number,
  body: object,
  headers: Record<string, string> = {},
): Reply => ({
  status,
  headers: {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    ...headers,
  },
  body: `${JSON.stringify(body)}\n`,
});

export const refuse = (status: number, error: string, headers?: Record<string, string>) =>
  json(status, { error }, headers);

const digest = (text: string) => createHash("sha256").update(text).digest();

const hashedConstantTimeEqual = (sent: string, secret: string): boolean =>
  timingSafeEqual(digest(sent), digest(secret));

const macOf = (expiry: string, token: string) =>
  createHmac("sha256", token).update(expiry).digest("base64url");

/** The cookie value for a session that ends at `expiry`, in Unix seconds. */
export const sessionValue = (expiry: number, token: string): string =>
  `${expiry}.${macOf(String(expiry), token)}`;

const SESSION = /^(?<expiry>[1-9]\d{0,11})\.(?<mac>[A-Za-z0-9_-]{43})$/;

const sessions = (cookie: string | undefined): ReadonlyArray<string> =>
  (cookie ?? "").split(";").flatMap((pair) => {
    const at = pair.indexOf("=");
    return at !== -1 && pair.slice(0, at).trim() === COOKIE ? [pair.slice(at + 1).trim()] : [];
  });

const validSession = (value: string, token: string, now: number): boolean => {
  const parts = SESSION.exec(value)?.groups;
  if (parts?.expiry === undefined || parts.mac === undefined) return false;
  return (
    Number(parts.expiry) * 1000 > now &&
    hashedConstantTimeEqual(parts.mac, macOf(parts.expiry, token))
  );
};

const BEARER = /^Bearer (?<token>\S+)$/;

/** Whether the request carries the hub token as a bearer, or a session cookie the hub made. */
export const loggedIn = (request: HubRequest, token: string, now: number): boolean => {
  const sent = BEARER.exec(request.headers.authorization ?? "")?.groups?.token;
  if (sent !== undefined && hashedConstantTimeEqual(sent, token)) return true;
  return sessions(request.headers.cookie).some((value) => validSession(value, token, now));
};

export const LOGGED_OUT = refuse(401, "Sign in with the token that devbox hub token prints.", {
  "www-authenticate": "Bearer",
});

/**
 * A browser names the page that sent a request in `Origin`. A request that changes something is
 * taken only from the hub's own page, or from a client that is not a browser and sends none.
 *
 * A proxy in front of the hub, such as the page's dev server, asks under its own name for the hub
 * and puts the name the browser asked in `X-Forwarded-Host`. A page on another site cannot set that
 * header, because the browser would first ask the hub's leave, which this check refuses.
 */
export const crossSite = (request: HubRequest): boolean => {
  const { origin } = request.headers;
  const host = request.headers["x-forwarded-host"]?.split(",")[0]?.trim() || request.headers.host;
  if (request.method === "GET" || origin === undefined) return false;
  if (host === undefined || !URL.canParse(origin)) return true;
  return new URL(origin).host.toLowerCase() !== host.toLowerCase();
};

const cookie = (value: string, maxAge: number) =>
  `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

const Login = Schema.fromJsonString(Schema.Struct({ token: Schema.String }));

/** `POST /api/login`: a session cookie for the hub token, which the hub does not keep. */
export const login = (request: HubRequest, token: string, now: number): Reply => {
  if (request.body === null)
    return refuse(413, "A login is not that long.", { connection: "close" });
  const sent = Schema.decodeUnknownOption(Login)(request.body, { onExcessProperty: "error" });
  if (Option.isNone(sent)) return refuse(400, 'Send {"token": "<hub token>"}.');
  if (!hashedConstantTimeEqual(sent.value.token, token))
    return refuse(403, "That is not the hub token.");
  const expiry = Math.floor(now / 1000) + SESSION_SECONDS;
  return {
    status: 204,
    headers: {
      "cache-control": "no-store",
      "set-cookie": cookie(sessionValue(expiry, token), SESSION_SECONDS),
    },
    body: "",
  };
};

/** `POST /api/logout`: the browser forgets its cookie. */
export const logout: Reply = {
  status: 204,
  headers: { "cache-control": "no-store", "set-cookie": cookie("", 0) },
  body: "",
};
