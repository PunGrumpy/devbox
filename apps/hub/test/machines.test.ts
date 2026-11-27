import { describe, expect, test } from "bun:test";

import {
  BAR_COUNT,
  bars,
  daySentences,
  groupByOs,
  lead,
  linkSentence,
  snapshotSchema,
  span,
  summarize,
  t3Sentence,
  uptime,
  vitalsMeters,
} from "@/lib/machines";
import type { Machine } from "@/lib/machines";

const base: Machine = {
  here: false,
  kind: "computer",
  name: "edge-7",
  spoke: null,
  state: "online",
  t3: null,
  tailscale: {
    dns: "edge-7.tail1234.ts.net",
    ip: "tailscale-ip-21",
    lastSeen: null,
    online: true,
    os: "linux",
  },
  tunnel: null,
  vitals: null,
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

const GB = 1024 ** 3;

describe("snapshotSchema", () => {
  test("parses a snapshot from an older hub without vitals, spoke, key, tunnel or cloudflare", () => {
    const parsed = snapshotSchema.parse({
      generatedAt: "2026-11-27T02:49:48Z",
      history: {
        sampleSeconds: 60,
        startedAt: "2026-11-26T02:50:00Z",
        states: { "edge-7": "2" },
      },
      latest: { t3: "0.1.14" },
      machines: [
        {
          here: false,
          kind: "computer",
          name: "edge-7",
          state: "t3",
          t3: null,
          tailscale: null,
        },
      ],
      tailscale: true,
    });

    expect(parsed.key).toBeNull();
    expect(parsed.cloudflare).toBeNull();
    expect(parsed.machines[0]?.vitals).toBeNull();
    expect(parsed.machines[0]?.spoke).toBeNull();
    expect(parsed.machines[0]?.tunnel).toBeNull();
  });

  test("keeps vitals, spoke, key, tunnel and cloudflare when present", () => {
    const parsed = snapshotSchema.parse({
      cloudflare: { zone: "example.com" },
      generatedAt: "2026-11-27T02:49:48Z",
      history: {
        sampleSeconds: 60,
        startedAt: "2026-11-26T02:50:00Z",
        states: { "edge-7": "2" },
      },
      key: "hub-public-key-sample",
      latest: { t3: "0.1.14" },
      machines: [
        {
          here: false,
          kind: "vm",
          name: "edge-7",
          spoke: "trusted",
          state: "t3",
          t3: null,
          tailscale: null,
          tunnel: { url: "https://t3-edge-7.example.com" },
          vitals: {
            disk: { total: 100 * GB, used: 61 * GB },
            load: 0.12,
            memory: { total: 16 * GB, used: Math.round(5.1 * GB) },
          },
        },
      ],
      tailscale: true,
    });

    expect(parsed.key).toBe("hub-public-key-sample");
    expect(parsed.cloudflare).toEqual({ zone: "example.com" });
    expect(parsed.machines[0]?.spoke).toBe("trusted");
    expect(parsed.machines[0]?.tunnel).toEqual({
      url: "https://t3-edge-7.example.com",
    });
    expect(parsed.machines[0]?.vitals?.load).toBeCloseTo(0.12, 5);
  });
});

describe("vitalsMeters", () => {
  test("prints load as a percent and memory and disk as used of total", () => {
    expect(
      vitalsMeters({
        disk: { total: 500 * GB, used: 210 * GB },
        load: 0.61,
        memory: { total: 32 * GB, used: 11 * GB },
      })
    ).toEqual([
      { fill: 61, high: false, label: "Load", value: "61%" },
      { fill: 34, high: false, label: "Memory", value: "11 of 32 GB" },
      { fill: 42, high: false, label: "Disk", value: "210 of 500 GB" },
    ]);
  });

  test("marks a meter at 90% and above, and not below", () => {
    const [load, memory, disk] = vitalsMeters({
      disk: { total: 500 * GB, used: 450 * GB },
      load: 0.89,
      memory: { total: 32 * GB, used: Math.round(28.8 * GB) },
    });

    expect(load?.high).toBe(false);
    expect(memory?.high).toBe(true);
    expect(disk?.high).toBe(true);
  });

  test("fills the track for load above 100% and still prints the real number", () => {
    const [load] = vitalsMeters({
      disk: { total: 100 * GB, used: 0 },
      load: 1.25,
      memory: { total: 8 * GB, used: Math.round(0.8 * GB) },
    });

    expect(load).toEqual({
      fill: 100,
      high: true,
      label: "Load",
      value: "125%",
    });
  });

  test("keeps one decimal below 10 GB and whole gigabytes above", () => {
    const [, memory, disk] = vitalsMeters({
      disk: { total: 100 * GB, used: 0 },
      load: 0,
      memory: { total: 8 * GB, used: Math.round(0.8 * GB) },
    });

    expect(memory?.value).toBe("0.8 of 8.0 GB");
    expect(disk).toEqual({
      fill: 0,
      high: false,
      label: "Disk",
      value: "0.0 of 100 GB",
    });
  });
});
