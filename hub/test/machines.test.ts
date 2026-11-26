import { describe, expect, test } from "bun:test";

import {
  bars,
  BAR_COUNT,
  describe as describeMachine,
  headline,
  span,
  summarize,
} from "@/lib/machines";
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

describe("describe", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");

  test("a machine that answered says its version and how long it took", () => {
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

    expect(describeMachine(answered, now)).toBe(
      "T3 Code 0.1.13 answered in 42 ms. Not linked for agents."
    );
  });

  test("a machine known only through its link says so, with the time left", () => {
    const linked = machine({
      state: "t3",
      t3: {
        environmentId: "id",
        label: "laptop",
        latencyMs: null,
        link: {
          access: "full-access",
          expiresAt: "2026-12-06T12:00:00Z",
          status: "reachable",
          urls: [],
        },
        url: null,
        version: null,
      },
    });

    expect(describeMachine(linked, now)).toBe(
      "T3 Code answers through its link. Linked for agents with full-access, 9d left."
    );
  });

  test("an offline machine says when it was last seen", () => {
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

    expect(describeMachine(offline, now)).toBe(
      "Last seen 10h ago. Not linked for agents."
    );
  });
});

describe("headline", () => {
  test("counts the machines that are online", () => {
    expect(
      headline(
        [machine({}), machine({ name: "gone", state: "offline" })],
        false
      )
    ).toEqual({
      accent: "online.",
      lead: "1 of 2 machines are",
    });
    expect(headline([machine({})], false)).toEqual({
      accent: "online.",
      lead: "All 1 machine is",
    });
  });

  test("before the first answer it says what it is waiting for", () => {
    expect(headline(null, false).lead).toBe("Asking the hub for");
    expect(headline(null, true).lead).toBe("The hub is");
    expect(headline([], false).accent).toBe("no machines.");
  });
});

describe("summarize", () => {
  test("counts the machines that run T3 Code and the ones linked for agents", () => {
    const linked = machine({
      name: "linked",
      state: "t3",
      t3: {
        environmentId: "id",
        label: "linked",
        latencyMs: null,
        link: {
          access: "full-access",
          expiresAt: "2026-12-25T00:00:00Z",
          status: "reachable",
          urls: [],
        },
        url: null,
        version: null,
      },
    });

    expect(summarize([linked, machine({ name: "plain" })])).toEqual({
      linked: 1,
      ready: 1,
    });
  });
});
