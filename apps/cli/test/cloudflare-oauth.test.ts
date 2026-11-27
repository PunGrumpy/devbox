import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import http from "node:http";
import { networkInterfaces } from "node:os";

import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, Option } from "effect";
import { Command } from "effect/cli";

import { hintOf } from "../src/errors.ts";
import {
  type Answer,
  authorizeUrl,
  CALLBACK_PORT,
  challengeOf,
  CLOUDFLARE,
  CLOUDFLARE_FLOW,
  exchange,
  type Flow,
  loginCommand,
  makePkce,
  makeState,
  OAuthFailed,
  parseTokens,
  type PostForm,
  readCallback,
  redirectUri,
  renew,
  SCOPES,
  type SignedIn,
} from "../src/hub/cloudflare-oauth.ts";
import { freePort } from "../src/machine/proxy.ts";
import { Output } from "../src/output.ts";

const ACCESS = "made-up-access-token-0123456789";
const REFRESH = "made-up-refresh-token-0123456789";
const NEW_REFRESH = "made-up-refresh-token-renewed-9876";
const CODE = "made-up-code-0123456789";
const CLIENT = "made-up-client-id";
const NOW = Date.parse("2026-11-27T12:00:00.000Z");

const tokenBody = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    access_token: ACCESS,
    token_type: "bearer",
    expires_in: 3600,
    refresh_token: REFRESH,
    scope: SCOPES.join(" "),
    ...fields,
  });

const fakePost = (answer: Answer) => {
  const sent: Array<{ url: string; form: Readonly<Record<string, string>> }> =
    [];
  const post: PostForm = (url, form) =>
    Effect.sync(() => {
      sent.push({ url, form });
      return answer;
    });
  return { post, sent };
};

const fails = async <A>(effect: Effect.Effect<A, OAuthFailed>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const error = exit.cause.reasons.find(
    (reason) => reason._tag === "Fail"
  )?.error;
  if (!(error instanceof OAuthFailed)) throw new Error("expected OAuthFailed");
  return error;
};

describe("PKCE", () => {
  test("the challenge is the S256 of the verifier, as in RFC 7636 appendix B", () => {
    expect(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
  });

  test("every login gets a new 43 character verifier and its challenge", () => {
    const one = makePkce();
    const two = makePkce();
    expect(one.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(one.challenge).toBe(challengeOf(one.verifier));
    expect(two.verifier).not.toBe(one.verifier);
    expect(makeState()).not.toBe(makeState());
  });
});

describe("the authorize address", () => {
  const pkce = makePkce();
  const url = new URL(
    authorizeUrl({
      authorize: CLOUDFLARE.authorize,
      clientId: CLIENT,
      redirectUri: redirectUri(CALLBACK_PORT),
      challenge: pkce.challenge,
      state: "made-up-state",
    })
  );

  test("asks Cloudflare for a code with PKCE, sent back to loopback", () => {
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://dash.cloudflare.com/oauth2/auth"
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: "http://127.0.0.1:3783/callback",
      scope:
        "zone.read dns.write argotunnel.write zone-waf.write offline_access",
      state: "made-up-state",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    });
  });

  test("never carries the verifier", () => {
    expect(url.href).not.toContain(pkce.verifier);
  });
});

describe("the callback", () => {
  const STATE = "made-up-state";

  test("a code with the right state", () => {
    expect(
      readCallback(`/callback?code=${CODE}&state=${STATE}`, STATE)
    ).toEqual({
      _tag: "Code",
      code: CODE,
    });
  });

  test("a wrong or missing state is refused, even with a code", () => {
    for (const url of [
      `/callback?code=${CODE}&state=other-state`,
      `/callback?code=${CODE}`,
      `/callback?code=${CODE}&state=`,
    ]) {
      const read = readCallback(url, STATE);
      expect(read._tag).toBe("Refused");
      if (read._tag === "Refused") {
        expect(read.message).toBe(
          "the answer did not come from this login, its state does not match"
        );
        expect(read.message).not.toContain(CODE);
      }
    }
  });

  test("an error Cloudflare sends is reported by its code", () => {
    expect(
      readCallback(`/callback?error=access_denied&state=${STATE}`, STATE)
    ).toEqual({
      _tag: "Refused",
      message: "Cloudflare did not sign the hub in: access_denied",
      hint: "run the login again and select Authorize",
    });
    expect(
      readCallback(`/callback?error=invalid_scope&state=${STATE}`, STATE)
    ).toEqual({
      _tag: "Refused",
      message: "Cloudflare did not sign the hub in: invalid_scope",
      hint: "check the client's redirect URL and scopes in the Cloudflare dashboard",
    });
  });

  test("an error that is not a plain code is not repeated to the terminal", () => {
    const read = readCallback(
      `/callback?error=${encodeURIComponent("\u001B[2Jbad")}&state=${STATE}`,
      STATE
    );
    expect(read).toMatchObject({
      message: "Cloudflare did not sign the hub in: an unnamed error",
    });
  });

  test("no code", () => {
    expect(readCallback(`/callback?state=${STATE}`, STATE)).toEqual({
      _tag: "Refused",
      message: "Cloudflare's answer has no code",
      hint: "run the login again",
    });
  });
});

describe("a token answer", () => {
  test("a bearer token: its tokens and when it ends", () => {
    expect(parseTokens(tokenBody(), NOW)).toEqual(
      Option.some({
        accessToken: ACCESS,
        refreshToken: REFRESH,
        expiresAt: "2026-11-27T13:00:00.000Z",
      })
    );
  });

  test("with no lifetime it is taken to end in five minutes", () => {
    expect(
      Option.map(
        parseTokens(tokenBody({ expires_in: undefined }), NOW),
        (t) => t.expiresAt
      )
    ).toEqual(Option.some("2026-11-27T12:05:00.000Z"));
  });

  test("a renewal with no new refresh token keeps the old one", () => {
    expect(
      Option.map(
        parseTokens(tokenBody({ refresh_token: undefined }), NOW, "kept"),
        (t) => t.refreshToken
      )
    ).toEqual(Option.some("kept"));
  });

  test("anything else is not the documented shape", () => {
    for (const body of [
      "",
      "not json",
      "null",
      "[]",
      tokenBody({ access_token: undefined }),
      tokenBody({ access_token: "" }),
      tokenBody({ access_token: 7 }),
      tokenBody({ token_type: "mac" }),
      tokenBody({ token_type: undefined }),
      tokenBody({ expires_in: -1 }),
      tokenBody({ expires_in: "3600" }),
      tokenBody({ refresh_token: undefined }),
    ])
      expect(parseTokens(body, NOW)).toEqual(Option.none());
  });
});

describe("exchange", () => {
  const request = {
    token: CLOUDFLARE.token,
    clientId: CLIENT,
    code: CODE,
    verifier: "made-up-verifier",
    redirectUri: redirectUri(CALLBACK_PORT),
  };

  test("sends the code with the verifier and no secret, and gets tokens", async () => {
    const { post, sent } = fakePost({ status: 200, body: tokenBody() });
    const tokens = await Effect.runPromise(exchange(post, request));
    expect(tokens.accessToken).toBe(ACCESS);
    expect(tokens.refreshToken).toBe(REFRESH);
    expect(sent).toEqual([
      {
        url: "https://dash.cloudflare.com/oauth2/token",
        form: {
          grant_type: "authorization_code",
          code: CODE,
          redirect_uri: "http://127.0.0.1:3783/callback",
          client_id: CLIENT,
          code_verifier: "made-up-verifier",
        },
      },
    ]);
  });

  test("a refusal names Cloudflare's error, not the code or the verifier", async () => {
    const { post } = fakePost({
      status: 400,
      body: JSON.stringify({
        error: "invalid_grant",
        error_description: `bad code ${CODE}`,
      }),
    });
    const error = await fails(exchange(post, request));
    expect(error.message).toBe(
      "Cloudflare did not take the sign-in code (400, invalid_grant)"
    );
    expect(`${error.message} ${error.hint}`).not.toContain(CODE);
    expect(`${error.message} ${error.hint}`).not.toContain("made-up-verifier");
  });

  test("an answer that is not the documented shape fails, without repeating it", async () => {
    const { post } = fakePost({
      status: 200,
      body: tokenBody({ token_type: "mac" }),
    });
    const error = await fails(exchange(post, request));
    expect(error.message).toBe(
      "Cloudflare's token answer is not a bearer token with a refresh token"
    );
    expect(error.message).not.toContain(ACCESS);
  });
});

describe("renew", () => {
  const login = { clientId: CLIENT, refreshToken: REFRESH };

  test("sends the refresh token and takes the new one", async () => {
    const { post, sent } = fakePost({
      status: 200,
      body: tokenBody({
        access_token: "made-up-access-2",
        refresh_token: NEW_REFRESH,
      }),
    });
    const tokens = await Effect.runPromise(renew(post, login));
    expect(tokens).toMatchObject({
      accessToken: "made-up-access-2",
      refreshToken: NEW_REFRESH,
    });
    expect(Date.parse(tokens.expiresAt) - Date.now()).toBeGreaterThan(
      3_500_000
    );
    expect(sent).toEqual([
      {
        url: "https://dash.cloudflare.com/oauth2/token",
        form: {
          grant_type: "refresh_token",
          refresh_token: REFRESH,
          client_id: CLIENT,
        },
      },
    ]);
  });

  test("a renewal Cloudflare refuses says to sign in again, and names no token", async () => {
    const { post } = fakePost({
      status: 401,
      body: JSON.stringify({
        error: "invalid_grant",
        error_description: "token revoked",
      }),
    });
    const error = await fails(renew(post, login));
    expect(error.message).toBe(
      "Cloudflare refused to renew the hub's login (401, invalid_grant)"
    );
    expect(error.hint).toBe(
      `sign in again with \`devbox hub cloudflare login --client-id ${CLIENT}\``
    );
    expect(`${error.message} ${error.hint}`).not.toContain(REFRESH);
  });

  test("a refusal that is not JSON still reads as one", async () => {
    const { post } = fakePost({ status: 503, body: "<html>down</html>" });
    expect((await fails(renew(post, login))).message).toBe(
      "Cloudflare refused to renew the hub's login (503, an unnamed error)"
    );
  });
});

const fakeCloudflare = async (options: { error?: string } = {}) => {
  const port = await Effect.runPromise(freePort);
  const seen = {
    challenge: "",
    verifier: "",
    forms: [] as Array<Record<string, string>>,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/oauth2/auth") {
      seen.challenge = url.searchParams.get("code_challenge") ?? "";
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      if (options.error === undefined) back.searchParams.set("code", CODE);
      else back.searchParams.set("error", options.error);
      res.writeHead(302, { location: back.href });
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const form = Object.fromEntries(new URLSearchParams(body));
      seen.forms.push(form);
      seen.verifier = form.code_verifier ?? "";
      const proven =
        form.grant_type === "authorization_code" &&
        form.code === CODE &&
        form.client_id === CLIENT &&
        createHash("sha256").update(seen.verifier).digest("base64url") ===
          seen.challenge;
      res.writeHead(proven ? 200 : 400, { "content-type": "application/json" });
      res.end(
        proven ? tokenBody() : JSON.stringify({ error: "invalid_grant" })
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve)
  );
  return {
    seen,
    endpoints: {
      authorize: `http://127.0.0.1:${port}/oauth2/auth`,
      token: `http://127.0.0.1:${port}/oauth2/token`,
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const capture = () => {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const output = Output.make({
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    paint: (_, text) => text,
    stdoutColor: false,
    interactive: false,
    readAnswer: Effect.die("no terminal in tests"),
    pickMany: () => Effect.die("no terminal in tests"),
  });
  return {
    all: () => `${out.join("")}${err.join("")}`,
    err: () => err.join(""),
    output,
  };
};

const runLogin = (
  flow: Flow,
  args: ReadonlyArray<string> = ["--client-id", CLIENT]
) => {
  const printed = capture();
  const saved: Array<SignedIn> = [];
  const root = Command.make("devbox").pipe(
    Command.withSubcommands([
      loginCommand((signedIn) => Effect.sync(() => saved.push(signedIn)), flow),
    ])
  );
  const done = Effect.runPromise(
    Command.runWith(root, { version: "0" })(["login", ...args]).pipe(
      Effect.as(0),
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* (yield* Output).error(error.message, hintOf(error));
          return 1;
        })
      ),
      Effect.provide(Layer.succeed(Output, printed.output)),
      Effect.provide(BunServices.layer)
    )
  );
  return { printed, saved, done };
};

const printedAddress = async (printed: ReturnType<typeof capture>) => {
  for (let tries = 0; tries < 200; tries += 1) {
    const found = /^ {2}(http\S+)$/m.exec(printed.err())?.[1];
    if (found !== undefined) return found;
    await Bun.sleep(10);
  }
  throw new Error(`no address printed: ${printed.err()}`);
};

const browse = async (address: string) => {
  const signedIn = await fetch(address, { redirect: "manual" });
  const back = signedIn.headers.get("location") ?? "";
  const page = await fetch(back);
  return {
    back,
    status: page.status,
    text: await page.text(),
    type: page.headers.get("content-type"),
  };
};

const refused = async (port: number) =>
  fetch(`http://127.0.0.1:${port}/callback`).then(
    () => false,
    () => true
  );

const flowFor = async (
  endpoints: Flow["endpoints"],
  waitMs = 10_000
): Promise<Flow> => ({
  ...CLOUDFLARE_FLOW,
  endpoints,
  port: await Effect.runPromise(freePort),
  waitMs,
});

describe("devbox hub cloudflare login", () => {
  test("signs in through the browser against a fake Cloudflare, saves the tokens and prints none", async () => {
    const cloudflare = await fakeCloudflare();
    const flow = await flowFor(cloudflare.endpoints);
    const { printed, saved, done } = runLogin(flow, [
      "--client-id",
      CLIENT,
      "--zone",
      "example.com",
    ]);
    const address = await printedAddress(printed);
    expect(new URL(address).searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${flow.port}/callback`
    );
    const page = await browse(address);
    expect(page.status).toBe(200);
    expect(page.type).toBe("text/plain; charset=utf-8");
    expect(page.text).toBe(
      "devbox has what it needs. Go back to the terminal; you can close this tab.\n"
    );
    expect(await done).toBe(0);
    await cloudflare.close();

    expect(saved).toHaveLength(1);
    expect(saved[0]?.clientId).toBe(CLIENT);
    expect(saved[0]?.tokens).toMatchObject({
      accessToken: ACCESS,
      refreshToken: REFRESH,
    });
    expect(saved[0]?.zone).toEqual(Option.some("example.com"));
    expect(saved[0]?.account).toEqual(Option.none());
    expect(cloudflare.seen.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const all = printed.all();
    expect(all).toContain("the hub is signed in to Cloudflare");
    for (const secret of [ACCESS, REFRESH, CODE, cloudflare.seen.verifier])
      expect(all).not.toContain(secret);
    expect(await refused(flow.port)).toBe(true);
  });

  test("a callback that carries an error fails the login with Cloudflare's code and saves nothing", async () => {
    const cloudflare = await fakeCloudflare({ error: "access_denied" });
    const flow = await flowFor(cloudflare.endpoints);
    const { printed, saved, done } = runLogin(flow);
    const page = await browse(await printedAddress(printed));
    expect(page.status).toBe(400);
    expect(page.text).toBe(
      "devbox did not get a sign-in. The terminal says why; you can close this tab.\n"
    );
    expect(await done).toBe(1);
    await cloudflare.close();
    expect(saved).toEqual([]);
    expect(cloudflare.seen.forms).toEqual([]);
    expect(printed.err()).toContain(
      "Error: Cloudflare did not sign the hub in: access_denied"
    );
    expect(printed.err()).toContain("run the login again and select Authorize");
  });

  test("a callback with the wrong state is refused before any code is traded", async () => {
    const cloudflare = await fakeCloudflare();
    const flow = await flowFor(cloudflare.endpoints);
    const { printed, saved, done } = runLogin(flow);
    await printedAddress(printed);
    const page = await fetch(
      `http://127.0.0.1:${flow.port}/callback?code=${CODE}&state=someone-elses-state`
    );
    expect(page.status).toBe(400);
    expect(await done).toBe(1);
    await cloudflare.close();
    expect(saved).toEqual([]);
    expect(cloudflare.seen.forms).toEqual([]);
    expect(printed.err()).toContain("its state does not match");
    expect(printed.all()).not.toContain(CODE);
  });

  test("the listener takes one callback, ignores other paths, and closes", async () => {
    const cloudflare = await fakeCloudflare();
    const flow = await flowFor(cloudflare.endpoints);
    const { printed, done } = runLogin(flow);
    const address = await printedAddress(printed);
    const favicon = await fetch(`http://127.0.0.1:${flow.port}/favicon.ico`);
    expect(favicon.status).toBe(404);
    expect((await browse(address)).status).toBe(200);
    expect(await done).toBe(0);
    await cloudflare.close();
    expect(await refused(flow.port)).toBe(true);
  });

  test("the listener is on loopback only", async () => {
    const cloudflare = await fakeCloudflare();
    const flow = await flowFor(cloudflare.endpoints);
    const { printed, done } = runLogin(flow);
    await printedAddress(printed);
    const outside = Object.values(networkInterfaces())
      .flat()
      .find(
        (face) => face !== undefined && face.family === "IPv4" && !face.internal
      )?.address;
    if (outside !== undefined)
      expect(
        await fetch(`http://${outside}:${flow.port}/callback`, {
          signal: AbortSignal.timeout(2000),
        }).then(
          () => "answered",
          () => "refused"
        )
      ).toBe("refused");
    await browse(await printedAddress(printed));
    expect(await done).toBe(0);
    await cloudflare.close();
  });

  test("no answer within the time limit fails the login and closes the listener", async () => {
    const cloudflare = await fakeCloudflare();
    const flow = await flowFor(cloudflare.endpoints, 200);
    const { printed, saved, done } = runLogin(flow);
    expect(await done).toBe(1);
    await cloudflare.close();
    expect(saved).toEqual([]);
    expect(printed.err()).toContain(
      "Error: no answer from Cloudflare within 1 second"
    );
    expect(await refused(flow.port)).toBe(true);
  });

  test("a port in use is named", async () => {
    const cloudflare = await fakeCloudflare();
    const flow = await flowFor(cloudflare.endpoints);
    const busy = http.createServer();
    await new Promise<void>((resolve) =>
      busy.listen(flow.port, "127.0.0.1", resolve)
    );
    const { printed, done } = runLogin(flow);
    expect(await done).toBe(1);
    busy.close();
    await cloudflare.close();
    expect(printed.err()).toContain(
      `Error: cannot listen on 127.0.0.1:${flow.port} for Cloudflare's answer`
    );
  });
});
