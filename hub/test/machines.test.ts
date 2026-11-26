import { describe, expect, test } from "bun:test";

import { bars, BAR_COUNT, span, stateText, summarize } from "@/lib/machines";
import type { Machine } from "@/lib/machines";

const base: Machine = {
  here: false,
  name: "edge-7",
  state: "online",
  t3: null,
  tailscale: {
    dns: "edge-7.tail1234.ts.net",
    ip: "tailscale-ip-21",
    lastSeen: null,
    online: true,
    os: "linux",
  },
};

const machine = (over: Partial<Machine>) => ({ ...base, ...over });

describe("span", () => {
  test("uses one short unit", () => {
    expect(span(42_000)).toBe("42s");
    expect(span(5 * 60_000)).toBe("5m");
    expect(span(3 * 3_600_000)).toBe("3h");
    expect(span(12 * 86_400_000)).toBe("12d");
  });

  test("a time in the future reads as now", () => {
    expect(span(-5000)).toBe("0s");
  });
});

describe("bars", () => {
  test("the newest sample lands in the last bar", () => {
    const result = bars("2", 60);
    expect(result).toHaveLength(BAR_COUNT);
    expect(result.at(-1)).toBe("t3");
    expect(result.slice(0, -1).every((bar) => bar === "unknown")).toBe(true);
  });

  test("a bar shows the worst state in its half hour", () => {
    const result = bars(`${"2".repeat(29)}0${"2".repeat(30)}`, 60);
    expect(result.slice(-2)).toEqual(["offline", "t3"]);
  });

  test("samples a machine was not known in are left out", () => {
    const result = bars(`${" ".repeat(30)}${"1".repeat(30)}`, 60);
    expect(result.slice(-2)).toEqual(["unknown", "online"]);
  });
});

describe("stateText", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");

  test("a machine that answered shows how long it took", () => {
    const answered = machine({
      state: "t3",
      t3: {
        environmentId: "id",
        label: "edge-7",
        latencyMs: 41.7,
        link: null,
        url: "https://edge-7.example.com",
        version: "0.1.13",
      },
    });

    expect(stateText(answered, now)).toBe("T3 Code ready · 42 ms");
  });

  test("an offline machine shows when it was last seen", () => {
    const offline = machine({
      state: "offline",
      tailscale: {
        dns: "edge-8.tail1234.ts.net",
        ip: "tailscale-ip-22",
        lastSeen: "2026-11-27T02:00:00Z",
        online: false,
        os: "linux",
      },
    });

    expect(stateText(offline, now)).toBe("Offline · seen 10h ago");
  });
});

describe("summarize", () => {
  test("counts states and finds the link that expires first", () => {
    const linked = (name: string, expiresAt: string) =>
      machine({
        name,
        state: "t3",
        t3: {
          environmentId: name,
          label: name,
          latencyMs: null,
          link: {
            expiresAt,
            access: "full-access",
            status: "reachable",
            urls: [],
          },
          url: null,
          version: null,
        },
      });

    const result = summarize([
      linked("late", "2026-12-25T00:00:00Z"),
      linked("soon", "2026-12-01T00:00:00Z"),
      machine({ name: "plain" }),
      machine({ name: "gone", state: "offline" }),
    ]);

    expect(result.total).toBe(4);
    expect(result.online).toBe(3);
    expect(result.ready).toBe(2);
    expect(result.linked).toBe(2);
    expect(result.nextExpiry?.name).toBe("soon");
    expect(result.slowest).toBeUndefined();
  });
});
