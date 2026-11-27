import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { Host } from "../src/machine/host.ts";

const answers = (port: number, address: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = yield* Host;
      return yield* host.answers(port, address);
    }).pipe(Effect.provide(Host.layer)),
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
    if (server === undefined) return;
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
    }).pipe(Effect.provide(Host.layer)),
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
      expect(Option.map(found, ({ body }) => body)).toEqual(Option.some("hello"));
      expect(Option.getOrThrow(found).ms).toBeGreaterThanOrEqual(0);
      expect(Option.isNone(await fetchText(`${origin}/missing`))).toBe(true);
    } finally {
      await server.stop(true);
    }
    expect(Option.isNone(await fetchText(`${origin}/ok`))).toBe(true);
  });
});
