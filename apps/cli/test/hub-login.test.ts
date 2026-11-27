import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import {
  type HubMachine,
  type HubRequest,
  type HubSnapshot,
  type Reply,
  route,
} from "../src/hub/hub.ts";
import type { Machine } from "../src/hub/machines.ts";
import { freePort } from "../src/machine/proxy.ts";
import { makeMachine } from "./support/host.ts";
import { devbox, start } from "./support/run.ts";

const TOKEN = "made-up-hub-token-0123456789abcdefghijklmnop";
const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const MONTH = 2_592_000;
const EXPIRY = NOW / 1000 + MONTH;

const machine = (name: string, spoke: Machine["spoke"]): HubMachine => ({
  name,
  here: false,
  kind: "computer",
  state: "t3",
  tailscale: null,
  t3: null,
  vitals: null,
  spoke,
  tunnel: null,
});

const SNAPSHOT: HubSnapshot = {
  generatedAt: "2026-11-27T12:00:00.000Z",
  tailscale: true,
  machines: [
    machine("edge-7", "trusted"),
    machine("edge-8", "untrusted"),
    machine("edge-9", null),
  ],
  history: {
    sampleSeconds: 60,
    startedAt: "2026-11-27T12:00:00.000Z",
    states: {},
    latency: {},
  },
  latest: { t3: null },
  key: "made-up-public-key",
  cloudflare: null,
};

const page = (pathname: string) =>
  pathname === "/"
    ? { body: new TextEncoder().encode("<!doctype html>"), path: "/index.html" }
    : undefined;

const request = (
  method: string,
  url: string,
  headers: HubRequest["headers"] = {},
  body: string | null = ""
): HubRequest => ({
  method,
  url,
  headers: { host: "hub.tail1234.ts.net:3780", ...headers },
  body,
});

const answer = (r: HubRequest, now = NOW, token = TOKEN) =>
  route(r, { snapshot: SNAPSHOT, token, now }, page);

const reply = (r: HubRequest, now = NOW, token = TOKEN): Reply => {
  const routed = answer(r, now, token);

  if (!("status" in routed)) {
    throw new Error(`asked ${routed.ask} instead of replying`);
  }
  return routed;
};

const errorOf = (r: Reply) =>
  (JSON.parse(String(r.body)) as { error: string }).error;

const mac = (expiry: string, token = TOKEN) =>
  createHmac("sha256", token).update(expiry).digest("base64url");

const loginBody = (token: string) => JSON.stringify({ token });

const cookieFrom = (r: Reply) => r.headers["set-cookie"]?.split(";")[0] ?? "";

const SESSION = cookieFrom(
  reply(request("POST", "/api/login", {}, loginBody(TOKEN)))
);

describe("logging in", () => {
  test("the right token answers 204 with a 30 day session cookie the hub can check without keeping it", () => {
    const r = reply(request("POST", "/api/login", {}, loginBody(TOKEN)));
    expect(r.status).toBe(204);
    expect(r.body).toBe("");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["set-cookie"]).toBe(
      `devbox_hub=${EXPIRY}.${mac(String(EXPIRY))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`
    );
  });

  test("the cookie names its expiry, signed with the hub token, and never holds the token", () => {
    expect(SESSION).toBe(`devbox_hub=${EXPIRY}.${mac(String(EXPIRY))}`);
    expect(SESSION).not.toContain(TOKEN);
  });

  test("a wrong token: 403, and no cookie", () => {
    for (const wrong of [
      `${TOKEN.slice(1)}x`,
      "",
      TOKEN.toUpperCase(),
      `${TOKEN} `,
    ]) {
      const r = reply(request("POST", "/api/login", {}, loginBody(wrong)));
      expect(r.status).toBe(403);
      expect(errorOf(r)).toBe("That is not the hub token.");
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
  });

  test("a body that is not {token}: 400", () => {
    for (const body of [
      "",
      "token",
      TOKEN,
      "null",
      "[]",
      JSON.stringify({ token: 7 }),
      JSON.stringify({ secret: TOKEN }),
      JSON.stringify({ token: TOKEN, admin: true }),
    ]) {
      const r = reply(request("POST", "/api/login", {}, body));
      expect(r.status).toBe(400);
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
  });

  test("a body longer than a login: 413, and the connection closes", () => {
    const r = reply(request("POST", "/api/login", {}, null));
    expect(r.status).toBe(413);
    expect(r.headers.connection).toBe("close");
  });

  test("the login path takes only POST", () => {
    expect(reply(request("GET", "/api/login")).status).toBe(405);
  });
});

const status = (headers: HubRequest["headers"], now = NOW, token = TOKEN) =>
  reply(request("GET", "/api/machines", headers), now, token).status;

describe("a logged in request", () => {
  test("carries the session cookie", () => {
    expect(status({ cookie: SESSION })).toBe(200);
    expect(status({ cookie: `theme=dark; ${SESSION}; other=1` })).toBe(200);
  });

  test("or the hub token as a bearer", () => {
    expect(status({ authorization: `Bearer ${TOKEN}` })).toBe(200);
  });

  test("and is answered with the snapshot, never kept by a cache", () => {
    const r = reply(request("GET", "/api/machines", { cookie: SESSION }));
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(String(r.body))).toEqual(SNAPSHOT);
  });
});

describe("a request that is not logged in: 401", () => {
  test("with nothing", () => {
    const r = reply(request("GET", "/api/machines"));
    expect(r.status).toBe(401);
    expect(errorOf(r)).toBe(
      "Sign in with the token that devbox hub token prints."
    );
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  test("anywhere under /api/, so a logged out caller cannot tell which paths exist", () => {
    for (const path of [
      "/api",
      "/api/",
      "/api/nope",
      "/api/machines/x",
      "/api/logout",
      "/api/machines/edge-7/update",
      "/api/machines/edge-7/pair",
    ]) {
      expect(reply(request("GET", path)).status).toBe(401);
    }
    expect(reply(request("POST", "/api/logout")).status).toBe(401);
  });

  test("with a wrong bearer token, or the token sent without Bearer", () => {
    expect(status({ authorization: `Bearer ${TOKEN.slice(1)}x` })).toBe(401);
    expect(status({ authorization: "Bearer " })).toBe(401);
    expect(status({ authorization: TOKEN })).toBe(401);
  });

  test("with a cookie past its expiry", () => {
    expect(status({ cookie: SESSION }, EXPIRY * 1000 - 1)).toBe(200);
    expect(status({ cookie: SESSION }, EXPIRY * 1000)).toBe(401);
  });

  test("with a cookie whose mac was changed", () => {
    const value = SESSION.split("=")[1] ?? "";
    const [expiry = "", sent = ""] = value.split(".");
    const flipped = `${sent.slice(0, -1)}${sent.endsWith("A") ? "B" : "A"}`;
    expect(status({ cookie: `devbox_hub=${expiry}.${flipped}` })).toBe(401);
    expect(status({ cookie: `devbox_hub=${expiry}.` })).toBe(401);
    expect(status({ cookie: `devbox_hub=${expiry}` })).toBe(401);
  });

  test("with a cookie whose expiry was pushed later without a new mac", () => {
    const sent = SESSION.split(".")[1] ?? "";
    expect(status({ cookie: `devbox_hub=${EXPIRY + MONTH}.${sent}` })).toBe(
      401
    );
  });

  test("with a cookie another hub made, or one made with a guess", () => {
    expect(
      status(
        { cookie: SESSION },
        NOW,
        "another-hub-token-0123456789abcdefghijklm"
      )
    ).toBe(401);
    expect(
      status({ cookie: `devbox_hub=${EXPIRY}.${mac(String(EXPIRY), "")}` })
    ).toBe(401);
    expect(status({ cookie: `devbox_hub=${EXPIRY}.${"A".repeat(43)}` })).toBe(
      401
    );
  });

  test("with the cookie under another name", () => {
    expect(
      status({ cookie: SESSION.replace("devbox_hub", "devbox_hub2") })
    ).toBe(401);
  });
});

describe("a page on another site", () => {
  const evil = "https://example.com";

  test("cannot POST anything, even with the token, and the check comes first: 403", () => {
    const signedIn = {
      origin: evil,
      authorization: `Bearer ${TOKEN}`,
      cookie: SESSION,
    };

    for (const path of [
      "/api/login",
      "/api/logout",
      "/api/machines/edge-7/update",
      "/api/machines/edge-7/pair",
      "/api/machines/edge-99/pair",
      "/api/nope",
      "/",
    ]) {
      const r = reply(request("POST", path, signedIn, loginBody(TOKEN)));
      expect(r.status).toBe(403);
      expect(errorOf(r)).toBe("This request came from a page on another site.");
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
  });

  test("is refused for an Origin of null, one that is not a URL, or a request with no Host", () => {
    expect(
      reply(request("POST", "/api/login", { origin: "null" }, loginBody(TOKEN)))
        .status
    ).toBe(403);
    expect(
      reply(request("POST", "/api/login", { origin: "::" }, loginBody(TOKEN)))
        .status
    ).toBe(403);

    const hostless: HubRequest = {
      method: "POST",
      url: "/api/login",
      headers: { origin: "http://hub.tail1234.ts.net:3780" },
      body: loginBody(TOKEN),
    };

    expect(reply(hostless).status).toBe(403);
  });

  test("the hub's own page may post, and so may a client that names no origin", () => {
    const own = { origin: "http://HUB.tail1234.ts.net:3780" };
    expect(
      reply(request("POST", "/api/login", own, loginBody(TOKEN))).status
    ).toBe(204);
    expect(
      reply(request("POST", "/api/login", {}, loginBody(TOKEN))).status
    ).toBe(204);
  });

  test("a GET from it carries no cookie, because the cookie is SameSite=Strict, so it reads nothing", () => {
    expect(
      reply(request("GET", "/api/machines", { origin: evil })).status
    ).toBe(401);
  });

  test("a name that DNS points at the hub reaches only the static page, never the data", () => {
    const rebound = {
      host: "evil.example.com:3780",
      origin: "http://evil.example.com:3780",
    };

    expect(reply(request("GET", "/", rebound)).status).toBe(200);
    expect(reply(request("GET", "/api/machines", rebound)).status).toBe(401);
    expect(
      reply(request("POST", "/api/machines/edge-7/pair", rebound)).status
    ).toBe(401);
    expect(
      reply(request("POST", "/api/login", rebound, loginBody("guess"))).status
    ).toBe(403);
  });
});

describe("logging out", () => {
  test("answers 204 and tells the browser to forget the cookie", () => {
    const r = reply(request("POST", "/api/logout", { cookie: SESSION }));
    expect(r.status).toBe(204);
    expect(r.headers["set-cookie"]).toBe(
      "devbox_hub=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
    );
  });

  test("takes only POST", () => {
    expect(
      reply(request("GET", "/api/logout", { cookie: SESSION })).status
    ).toBe(405);
  });
});

describe("the page's static files", () => {
  test("stay open, because they hold no data", () => {
    expect(reply(request("GET", "/")).status).toBe(200);
    expect(reply(request("GET", "/nope")).status).toBe(404);
  });
});

describe("a request for a machine passes one admission step", () => {
  const signedIn = { cookie: SESSION };

  test("logged in, for a machine whose spoke trusts this hub: the hub asks that spoke", () => {
    for (const action of ["update", "pair"] as const) {
      const routed = answer(
        request("POST", `/api/machines/edge-7/${action}`, signedIn)
      );

      expect(routed).toEqual({ ask: action, machine: SNAPSHOT.machines[0]! });
    }
  });

  test("logged out: 401, before the hub says whether the machine exists", () => {
    for (const action of ["update", "pair"]) {
      expect(
        reply(request("POST", `/api/machines/edge-7/${action}`)).status
      ).toBe(401);
      expect(
        reply(request("POST", `/api/machines/edge-99/${action}`)).status
      ).toBe(401);
    }
  });

  test("an unknown machine: 404", () => {
    for (const action of ["update", "pair"]) {
      expect(
        reply(request("POST", `/api/machines/edge-99/${action}`, signedIn))
          .status
      ).toBe(404);
    }
  });

  test("a machine whose spoke does not trust this hub, or has no spoke: 409", () => {
    for (const action of ["update", "pair"]) {
      const untrusted = reply(
        request("POST", `/api/machines/edge-8/${action}`, signedIn)
      );

      expect(untrusted.status).toBe(409);
      expect(errorOf(untrusted)).toBe("edge-8 does not trust this hub's key.");

      const none = reply(
        request("POST", `/api/machines/edge-9/${action}`, signedIn)
      );

      expect(errorOf(none)).toBe("edge-9 has no devbox spoke that answers.");
    }
  });

  test("an action the hub does not know is no machine path", () => {
    expect(
      reply(request("POST", "/api/machines/edge-7/untunnel", signedIn)).status
    ).toBe(404);
    expect(
      reply(request("POST", "/api/machines/edge-7/reboot", signedIn)).status
    ).toBe(404);
  });
});

describe("devbox hub, logged in through a browser", async () => {
  const m = makeMachine();
  const port = await Effect.runPromise(freePort);
  const empty = mkdtempSync(join(tmpdir(), "devbox-hub-ui-"));

  const hub = start(
    { HOME: m.home },
    ["hub", "--port", String(port), "--ui", empty],
    {
      host: m.host,
    }
  );

  for (let i = 0; i < 100 && !hub.err().includes("hub:"); i += 1) {
    await Bun.sleep(20);
  }
  afterAll(() => hub.stop());
  const base = `http://127.0.0.1:${port}`;

  const token = (
    await devbox({ HOME: m.home }, ["hub", "token"], { host: m.host })
  ).out.trim();

  const post = (
    path: string,
    body: string,
    headers: Record<string, string> = {}
  ) => fetch(`${base}${path}`, { method: "POST", headers, body });

  test("a login sets the cookie, the cookie reads the machines, and a logout clears it", async () => {
    expect((await fetch(`${base}/api/machines`)).status).toBe(401);
    const login = await post("/api/login", loginBody(token), { origin: base });
    expect(login.status).toBe(204);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^devbox_hub=\d+\.[A-Za-z0-9_-]{43}$/);
    expect(
      (await fetch(`${base}/api/machines`, { headers: { cookie } })).status
    ).toBe(200);
    const logout = await post("/api/logout", "", { cookie, origin: base });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("a login with a huge body is cut off at a kilobyte and the hub still answers", async () => {
    const answered = await new Promise<number>((done, fail) => {
      const req = http.request(
        `${base}/api/login`,
        { method: "POST" },
        (response) => {
          response.resume();
          done(response.statusCode ?? 0);
        }
      );

      req.on("error", fail);
      req.end(JSON.stringify({ token: "x".repeat(64 * 1024) }));
    });

    expect(answered).toBe(413);
    expect((await post("/api/login", loginBody(token))).status).toBe(204);
  });

  test("a login is never logged, right or wrong", async () => {
    await post("/api/login", loginBody("a-wrong-guess-0123456789"));
    expect(hub.err()).not.toContain(token);
    expect(hub.err()).not.toContain("a-wrong-guess-0123456789");
    expect(hub.out()).not.toContain(token);
  });
});
