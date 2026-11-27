import { describe, expect, test } from "bun:test";

import {
  latencyBuckets,
  latencyChart,
  latencyLabels,
  latencyPercentiles,
} from "@/lib/latency";
import { BAR_COUNT, snapshotSchema } from "@/lib/machines";
import type { Machine } from "@/lib/machines";

const sampleMachine: Machine = {
  here: false,
  kind: "computer",
  name: "edge-7",
  spoke: null,
  state: "t3",
  t3: {
    environmentId: "id",
    label: "edge-7",
    latencyMs: 38,
    link: null,
    url: "https://edge-7.example.com",
    version: "0.1.14",
  },
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

const repeat = <T>(count: number, value: T) =>
  Array.from({ length: count }, () => value);

describe("latencyBuckets", () => {
  test("puts the newest sample in the last bucket and leaves earlier ones null", () => {
    const result = latencyBuckets([24], 60);
    expect(result).toHaveLength(BAR_COUNT);
    expect(result.at(-1)).toBe(24);
    expect(result.slice(0, -1).every((bucket) => bucket === null)).toBe(true);
  });

  test("buckets 1440 samples into 48 half-hour medians", () => {
    const samples = Array.from({ length: 1440 }, (_, index) => {
      const bucket = Math.floor(index / 30);
      const offset = index % 30;

      return offset === 29 ? 999 : bucket + 10;
    });

    const result = latencyBuckets(samples, 60);
    expect(result).toHaveLength(BAR_COUNT);
    expect(result[0]).toBe(10);
    expect(result[23]).toBe(33);
    expect(result[47]).toBe(57);
  });

  test("ignores null samples inside a bucket and returns null when a bucket is empty", () => {
    const first = [...repeat(27, null), 10, 40, 20];
    const second = repeat(30, null);
    const third = [...repeat(28, null), 10, 20];

    const result = latencyBuckets([...first, ...second, ...third], 60);
    expect(result.slice(-3)).toEqual([20, null, 15]);
  });
});

describe("latencyPercentiles", () => {
  test("says nothing when fewer than 30 samples answered", () => {
    expect(latencyPercentiles([])).toBeNull();
    expect(latencyPercentiles(repeat(29, 18))).toBeNull();
    expect(
      latencyPercentiles([...repeat(100, null), ...repeat(29, 18)])
    ).toBeNull();
  });

  test("reads p50, p95 and p99 from the answered samples in whole milliseconds", () => {
    const samples = Array.from(
      { length: 100 },
      (_, index) => index + 1
    ).flatMap((value) => [value, null]);

    expect(latencyPercentiles(samples)).toEqual({ p50: 51, p95: 95, p99: 99 });
  });

  test("a machine that always answers in the same time has one number for all three", () => {
    expect(latencyPercentiles(repeat(30, 38))).toEqual({
      p50: 38,
      p95: 38,
      p99: 38,
    });
  });
});

describe("latencyChart", () => {
  test("draws nothing when every bucket is null", () => {
    expect(latencyChart(repeat(BAR_COUNT, null), 480, 36)).toBeNull();
    expect(latencyChart([], 480, 36)).toBeNull();
  });

  test("breaks the line and the fill under it across null gaps", () => {
    const chart = latencyChart([10, 20, null, 30, null, 10, 30], 70, 30);

    expect(chart?.line).toBe("M 5 20 L 15 10 M 35 0 L 35 0 M 55 20 L 65 0");
    expect(chart?.area).toBe(
      "M 5 30 L 5 20 L 15 10 L 15 30 Z M 35 30 L 35 0 L 35 30 Z M 55 30 L 55 20 L 65 0 L 65 30 Z"
    );
  });

  test("measures from zero up to the slowest half hour, which tops the scale", () => {
    expect(latencyChart([12, 12, 12], 30, 30)?.line).toBe(
      "M 5 0 L 15 0 L 25 0"
    );
    expect(latencyChart([40.4, null, 85.6], 30, 30)?.max).toBe(86);
  });
});

describe("latencyLabels", () => {
  test("names each half hour by its local start time and its median", () => {
    const generatedAt = new Date(2026, 10, 27, 14, 30).toISOString();
    const buckets = [38, ...repeat(BAR_COUNT - 3, 40), null, 42.4];
    const labels = latencyLabels(buckets, generatedAt);

    expect(labels).toHaveLength(BAR_COUNT);
    expect(labels[0]).toBe("14:30, 38 ms");
    expect(labels[1]).toBe("15:00, 40 ms");
    expect(labels.slice(-2)).toEqual(["13:30, no answer", "14:00, 42 ms"]);
  });
});

describe("snapshotSchema latency compatibility", () => {
  test("defaults history.latency to an empty object for older snapshots", () => {
    const parsed = snapshotSchema.parse({
      generatedAt: "2026-11-27T00:00:00.000Z",
      history: {
        sampleSeconds: 60,
        startedAt: "2026-11-26T00:00:00.000Z",
        states: { "edge-7": "2" },
      },
      latest: { t3: "0.1.14" },
      machines: [sampleMachine],
      tailscale: true,
    });

    expect(parsed.history.latency).toEqual({});
  });
});
