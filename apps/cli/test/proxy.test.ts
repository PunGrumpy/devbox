import { afterAll, describe, expect, test } from "bun:test";

import { Effect, Exit, Scope } from "effect";

import { freePort, proxy, rewriteHeaders } from "../src/machine/proxy.ts";

describe("rewriteHeaders", () => {
  const PUBLIC = "https://edge-7.example.com";

  test("requests from this machine keep their own Host", () => {
    const headers = { host: "127.0.0.1:3773" };
    expect(rewriteHeaders(headers, PUBLIC)).toBe(headers);
  });

  test("requests through an edge proxy get the public host and scheme", () => {
    expect(
      rewriteHeaders(
        { host: "172.16.0.9:3773", "x-forwarded-proto": "http" },
        PUBLIC
      )
    ).toEqual({
      host: "edge-7.example.com",
      "x-forwarded-proto": "https",
    });
  });

  test("an edge X-Forwarded-Host wins over the flag", () => {
    expect(
      rewriteHeaders(
        { host: "10.0.0.1", "x-forwarded-host": "alias.example.com" },
        PUBLIC
      ).host
    ).toBe("alias.example.com");
  });

  test("a chained or empty X-Forwarded-Host still gives one valid Host", () => {
    const first = rewriteHeaders(
      {
        host: "10.0.0.1",
        "x-forwarded-host": "edge1.example.com, edge2.example.com",
      },
      PUBLIC
    );

    expect(first.host).toBe("edge1.example.com");

    const empty = rewriteHeaders(
      { host: "10.0.0.1", "x-forwarded-host": "" },
      PUBLIC
    );

    expect(empty.host).toBe(new URL(PUBLIC).host);
  });
});

describe("the in-process proxy", async () => {
  const upstream = Bun.serve<string | null>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, server) =>
      server.upgrade(req, { data: req.headers.get("host") })
        ? undefined
        : Response.json({
            host: req.headers.get("host"),
            proto: req.headers.get("x-forwarded-proto"),
            path: new URL(req.url).pathname,
          }),
    websocket: {
      message: (ws, msg) => {
        ws.send(`${ws.data}:${msg}`);
      },
    },
  });

  const scope = await Effect.runPromise(Scope.make());
  const port = await Effect.runPromise(freePort);
  await Effect.runPromise(
    proxy({
      host: "127.0.0.1",
      port,
      upstream: upstream.port!,
      publicUrl: "http://example.test",
    }).pipe(Scope.provide(scope))
  );
  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    upstream.stop(true);
  });

  test("forwards HTTP and rewrites Host for edge traffic", async () => {
    const local = await (await fetch(`http://127.0.0.1:${port}/a?b=1`)).json();
    expect(local).toEqual({
      host: `127.0.0.1:${port}`,
      proto: null,
      path: "/a",
    });

    const edge = await (
      await fetch(
        `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`,
        {
          headers: { "x-forwarded-proto": "https" },
        }
      )
    ).json();

    expect(edge).toEqual({
      host: "example.test",
      proto: "http",
      path: "/.well-known/oauth-protected-resource",
    });
  });

  test("passes WebSocket upgrades through with the rewritten Host", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { "x-forwarded-proto": "https" },
    });

    const reply = await new Promise<string>((resolve, reject) => {
      ws.addEventListener("open", () => ws.send("ping"));
      ws.addEventListener("message", (event) => resolve(String(event.data)));
      ws.addEventListener("error", () => reject(new Error("websocket failed")));
    });

    ws.close();
    expect(reply).toBe("example.test:ping");
  });

  test("answers 502 when T3 is down", async () => {
    const deadPort = await Effect.runPromise(freePort);
    const scope2 = await Effect.runPromise(Scope.make());
    const port2 = await Effect.runPromise(freePort);
    await Effect.runPromise(
      proxy({
        host: "127.0.0.1",
        port: port2,
        upstream: deadPort,
        publicUrl: "http://example.test",
      }).pipe(Scope.provide(scope2))
    );
    expect((await fetch(`http://127.0.0.1:${port2}/`)).status).toBe(502);
    await Effect.runPromise(Scope.close(scope2, Exit.void));
  });
});
