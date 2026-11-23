import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
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
