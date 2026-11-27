import { describe, expect, test } from "bun:test";

import {
  bars,
  BAR_COUNT,
  groupByOs,
  lead,
  linkSentence,
  span,
  summarize,
  t3Sentence,
  daySentences,
  uptime,
} from "@/lib/machines";
import type { Machine } from "@/lib/machines";

const base: Machine = {
  here: false,
  kind: "computer",
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

describe("what the page says about a machine", () => {
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

    expect(t3Sentence(answered, now)).toBe("T3 Code 0.1.13 answered in 42 ms");
    expect(linkSentence(null, now)).toBe("Not linked for agents.");
  });

  test("a link says its access and the time it has left", () => {
    const link = {
      access: "full-access",
      expiresAt: "2026-12-06T12:00:00Z",
      status: "reachable",
      urls: [],
    };

    expect(linkSentence(link, now)).toBe(
      "Linked for agents with full-access, 9d left."
    );
    expect(linkSentence({ ...link, status: "unreachable" }, now)).toBe(
      "Linked for agents but unreachable, 9d left."
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

    expect(t3Sentence(offline, now)).toBe("Last seen 10h ago");
  });
});

describe("lead", () => {
  test("counts the machines that are online", () => {
    expect(
      lead([machine({}), machine({ name: "gone", state: "offline" })], false)
    ).toBe("1 of 2 machines are online.");
    expect(lead([machine({})], false)).toBe("All 1 machine is online.");
  });

  test("before the first answer it says what it is waiting for", () => {
    expect(lead(null, false)).toBe("Asking the hub for its machines.");
    expect(lead(null, true)).toBe("The hub is not answering.");
    expect(lead([], false)).toBe("The hub knows no machines.");
  });
});

describe("groupByOs", () => {
  test("lists macOS, Windows and Linux in that order, then machines off the tailnet", () => {
    const on = (name: string, os: string) =>
      machine({
        name,
        tailscale: {
          dns: `${name}.tail1234.ts.net`,
          ip: "ip",
          lastSeen: null,
          online: true,
          os,
        },
      });

    const groups = groupByOs([
      on("box", "linux"),
      machine({ name: "cloud", tailscale: null }),
      on("pc", "windows"),
      on("laptop", "macOS"),
      on("nas", "linux"),
    ]);

    expect(
      groups.map(({ label, machines }) => [label, machines.map((m) => m.name)])
    ).toEqual([
      ["macOS", ["laptop"]],
      ["Windows", ["pc"]],
      ["Linux", ["box", "nas"]],
      ["Elsewhere", ["cloud"]],
    ]);
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

describe("uptime", () => {
  test("says nothing until thirty samples are known", () => {
    expect(uptime("2".repeat(29))).toBeNull();
    expect(uptime(`${" ".repeat(100)}${"2".repeat(29)}`)).toBeNull();
  });

  test("counts online and T3 Code samples as up, and skips unknown ones", () => {
    expect(uptime("2".repeat(40))).toBe(100);
    expect(uptime(`${"1".repeat(20)}${" ".repeat(50)}${"0".repeat(20)}`)).toBe(
      50
    );
    expect(uptime(`${"0".repeat(10)}${"2".repeat(20)}`)).toBe(67);
  });
});

const running = (version: string | null) =>
  machine({
    state: "t3",
    t3: {
      environmentId: "id",
      label: "edge-7",
      latencyMs: 12,
      link: null,
      url: "https://edge-7.example.com",
      version,
    },
  });

describe("daySentences", () => {
  test("names a newer T3 Code only when both versions are known and differ", () => {
    expect(daySentences(running("0.1.13"), "", "0.1.14")).toBe(
      "T3 Code 0.1.14 is out."
    );
    expect(daySentences(running("0.1.14"), "", "0.1.14")).toBe("");
    expect(daySentences(running(null), "", "0.1.14")).toBe("");
    expect(daySentences(running("0.1.13"), "", null)).toBe("");
  });

  test("puts the day before the update", () => {
    expect(daySentences(running("0.1.13"), "2".repeat(60), "0.1.14")).toBe(
      "Online 100% of the last 24 hours. T3 Code 0.1.14 is out."
    );
  });
});
