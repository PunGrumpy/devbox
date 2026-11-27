import { describe, expect, test } from "bun:test";

import type { Machine } from "@/lib/machines";
import { anchorOf, mark, search } from "@/lib/search";

const NOW = Date.parse("2026-01-01T00:00:00Z");

const machine = (name: string, os: string, over: Partial<Machine> = {}) =>
  ({
    here: false,
    kind: "computer",
    name,
    spoke: null,
    state: "online",
    t3: null,
    tailscale: {
      dns: `${name}.tail1234.ts.net`,
      ip: "tailscale-ip-21",
      lastSeen: null,
      online: true,
      os,
    },
    tunnel: null,
    vitals: null,
    ...over,
  }) satisfies Machine;

const fleet = [
  machine("edge-7", "linux"),
  machine("studio", "macOS", { kind: "mac" }),
  machine("edge-9", "linux", { state: "offline" }),
];

const names = (query: string) =>
  search(fleet, query, NOW).groups.flatMap(({ hits }) =>
    hits.map(({ machine: found }) => found.name)
  );

describe("mark", () => {
  test("splits text around what the query matched, whatever the case", () => {
    expect(mark("Edge-7 edge", "edge")).toEqual([
      { at: 0, hit: true, text: "Edge" },
      { at: 4, hit: false, text: "-7 " },
      { at: 7, hit: true, text: "edge" },
    ]);
  });

  test("leaves text whole without a query", () => {
    expect(mark("edge-7", "  ")).toEqual([
      { at: 0, hit: false, text: "edge-7" },
    ]);
  });

  test("reads a query as text, not as a pattern", () => {
    expect(mark("a.b axb", "a.b")).toEqual([
      { at: 0, hit: true, text: "a.b" },
      { at: 3, hit: false, text: " axb" },
    ]);
    expect(mark("abc", "(")).toEqual([{ at: 0, hit: false, text: "abc" }]);
  });
});

describe("search", () => {
  test("finds nothing for an empty query", () => {
    expect(search(fleet, " ", NOW)).toEqual({ count: 0, groups: [] });
  });

  test("finds a machine by name, address, system or state", () => {
    expect(names("studio")).toEqual(["studio"]);
    expect(names("studio.tail1234")).toEqual(["studio"]);
    expect(names("linux")).toEqual(["edge-7", "edge-9"]);
    expect(names("offline")).toEqual(["edge-9"]);
    expect(names("mac")).toEqual(["studio"]);
  });

  test("needs every word of the query", () => {
    expect(names("edge offline")).toEqual(["edge-9"]);
    expect(names("edge studio")).toEqual([]);
  });

  test("groups hits by system and numbers them in the order shown", () => {
    const { count, groups } = search(fleet, "tailscale-ip", NOW);

    expect(count).toBe(3);
    expect(groups.map(({ label }) => label)).toEqual(["macOS", "Linux"]);
    expect(
      groups.flatMap(({ hits }) =>
        hits.map(({ index, machine: found }) => `${index}:${found.name}`)
      )
    ).toEqual(["0:studio", "1:edge-7", "2:edge-9"]);
  });

  test("marks the match in the title and in the excerpt", () => {
    const [group] = search(fleet, "edge-7", NOW).groups;
    const [hit] = group?.hits ?? [];

    expect(hit?.title).toEqual([{ at: 0, hit: true, text: "edge-7" }]);
    expect(
      hit?.excerpt.filter(({ hit: matched }) => matched).map(({ text }) => text)
    ).toEqual(["edge-7"]);
  });
});

test("a card id is derived from the machine name", () => {
  expect(anchorOf("edge-7")).toBe("machine-edge-7");
});
