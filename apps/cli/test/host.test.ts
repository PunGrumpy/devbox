import { describe, expect, test } from "bun:test";

import { Effect, Option } from "effect";

import { Host } from "../src/machine/host.ts";

const answers = (port: number, address: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = yield* Host;

      return yield* host.answers(port, address);
    }).pipe(Effect.provide(Host.layer))
  );

const listen = (hostname: string) => {
  try {
    return Bun.serve({ hostname, port: 0, fetch: () => new Response("ok") });
  } catch {
    return undefined;
  }
};

describe("Host.answers", () => {
  test("probes the address it is given, not loopback", async () => {
    const server = listen("127.0.0.1")!;

    try {
      expect(await answers(server.port!, "127.0.0.1")).toBe(true);
      expect(await answers(server.port!, "127.0.0.2")).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("puts an IPv6 address in brackets", async () => {
    const server = listen("::1");

    if (server === undefined) {
      return;
    }

    try {
      expect(await answers(server.port!, "::1")).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});

const fetchText = (url: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = yield* Host;

      return yield* host.fetchText(url, 2000);
    }).pipe(Effect.provide(Host.layer))
  );

describe("Host.fetchText", () => {
  test("gives the body of a 200 and nothing for any other answer or none", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/ok"
          ? new Response("hello")
          : new Response("gone", { status: 404 }),
    });

    const origin = `http://127.0.0.1:${server.port}`;

    try {
      const found = await fetchText(`${origin}/ok`);
      expect(Option.map(found, ({ body }) => body)).toEqual(
        Option.some("hello")
      );
      expect(Option.getOrThrow(found).ms).toBeGreaterThanOrEqual(0);
      expect(Option.isNone(await fetchText(`${origin}/missing`))).toBe(true);
    } finally {
      await server.stop(true);
    }

    expect(Option.isNone(await fetchText(`${origin}/ok`))).toBe(true);
  });
});

const host = <A>(use: (h: Host["Service"]) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* Host);
    }).pipe(Effect.provide(Host.layer))
  );

describe("Host.fetchText", () => {
  test("reads a small answer and gives up on one past a megabyte, with or without its length", async () => {
    const big = "x".repeat(2 * 1024 * 1024);

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;

        if (path === "/small") {
          return new Response("ok");
        }

        if (path === "/sized") {
          return new Response(big);
        }

        return new Response(
          new ReadableStream({
            start: (c) => {
              for (let i = 0; i < 32; i += 1) {
                c.enqueue(new TextEncoder().encode(big.slice(0, 65_536)));
              }

              c.close();
            },
          })
        );
      },
    });

    try {
      const at = (path: string) =>
        host((h) =>
          h.fetchText(`http://127.0.0.1:${server.port}${path}`, 2000)
        );

      expect(Option.map(await at("/small"), ({ body }) => body)).toEqual(
        Option.some("ok")
      );
      expect(Option.isNone(await at("/sized"))).toBe(true);
      expect(Option.isNone(await at("/streamed"))).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});

describe("Host.vitals", () => {
  test("reads this machine", async () => {
    const v = await host((h) => h.vitals("/"));
    expect(v.load).toBeGreaterThanOrEqual(0);
    expect(v.memory.used).toBeLessThanOrEqual(v.memory.total);
    expect(v.memory.total).toBeGreaterThan(0);
    expect(v.disk.used).toBeLessThanOrEqual(v.disk.total);
    expect(v.disk.total).toBeGreaterThan(0);
  });
});
