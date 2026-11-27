import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Option } from "effect";

import { HISTORY_LIMIT, nextHistory } from "../src/hub/hub.ts";
import type { HubSnapshot } from "../src/hub/hub.ts";
import type { Machine, MachineState, Snapshot } from "../src/hub/machines.ts";
import { restore, serialize } from "../src/hub/saved.ts";
import { freePort } from "../src/machine/proxy.ts";
import { makeMachine } from "./support/host.ts";
import { asOwner, devbox, start } from "./support/run.ts";

const SNEAKY = `</script><script>alert(1)</script>$&$'`;

const sneakyComputer = () => {
  const m = makeMachine();
  m.binaries.add("tailscale");
  m.binaries.add("t3");
  m.respond = (argv) => {
    if (argv[0] === "tailscale") {
      return {
        code: 0,
        stdout: JSON.stringify({
          Self: {
            HostName: "edge-7",
            DNSName: "edge-7.tail1234.ts.net.",
            TailscaleIPs: ["100.64.0.21"],
            OS: "linux",
            Online: true,
          },
        }),
        stderr: "",
      };
    }

    if (argv[1] === "environment") {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            environmentId: "env-x",
            label: SNEAKY,
            urls: ["http://laptop-3.tail1234.ts.net:3773/"],
            access: "full-access",
            expiresAt: "2026-12-01T00:00:00.000Z",
            status: "reachable",
          },
        ]),
        stderr: "",
      };
    }

    return undefined;
  };

  m.pages.set(
    "http://100.64.0.21:3773/.well-known/t3/environment",
    JSON.stringify({
      environmentId: "env-7",
      label: "edge-7",
      serverVersion: "0.2.0",
    })
  );

  return m;
};

/** A built page with one hashed asset, and a file beside it that the hub must never serve. */
const builtPage = () => {
  const base = mkdtempSync(join(tmpdir(), "devbox-hub-"));
  const ui = join(base, "out");
  mkdirSync(join(ui, "_next/static/chunks"), { recursive: true });
  writeFileSync(
    join(ui, "index.html"),
    "<!doctype html><title>devbox hub</title>"
  );
  writeFileSync(join(ui, "_next/static/chunks/app.js"), "console.log(1)");
  writeFileSync(join(base, "secret.txt"), "outside the page");

  return ui;
};

/** The hub keeps its history under HOME, so every test gets a home of its own. */
const freshHome = () => mkdtempSync(join(tmpdir(), "devbox-hub-home-"));

/** A path sent as written, because fetch would resolve the dots before it left. */
const rawStatus = (port: number, path: string) =>
  new Promise<number>((done, fail) => {
    http
      .get({ host: "127.0.0.1", port, path }, (response) => {
        response.resume();
        done(response.statusCode ?? 0);
      })
      .on("error", fail);
  });

describe("devbox hub", async () => {
  const m = sneakyComputer();
  const port = await Effect.runPromise(freePort);

  const running = start(
    { HOME: m.home },
    ["hub", "--port", String(port), "--ui", builtPage()],
    {
      host: m.host,
    }
  );

  const base = `http://127.0.0.1:${port}`;

  for (let i = 0; i < 100 && !running.err().includes("hub:"); i += 1) {
    await Bun.sleep(20);
  }

  afterAll(() => running.stop());

  test("logs the URL it listens on", () => {
    expect(running.err()).toContain(`hub: http://127.0.0.1:${port}/`);
  });

  test("/api/machines serves the snapshot with one sample of history", async () => {
    const response = await fetch(`${base}/api/machines`, {
      headers: asOwner(m.home),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    const json = (await response.json()) as HubSnapshot;
    expect(json.tailscale).toBe(true);
    expect(json.machines.map((x: Machine) => [x.name, x.state])).toEqual([
      ["edge-7", "t3"],
      [SNEAKY, "t3"],
    ]);
    expect(json.history).toEqual({
      sampleSeconds: 60,
      startedAt: json.generatedAt,
      states: { "edge-7": "2", [SNEAKY]: "2" },
      latency: { "edge-7": [12], [SNEAKY]: [null] },
    });
    expect(json.latest).toEqual({ t3: null });
  });

  test("/ serves the built page", async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8"
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("<title>devbox hub</title>");
  });

  test("a file Next named by its content may be kept for good", async () => {
    const response = await fetch(`${base}/_next/static/chunks/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8"
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(await response.text()).toBe("console.log(1)");
  });

  test("a path cannot climb out of the built page", async () => {
    expect(await rawStatus(port, "/../secret.txt")).toBe(404);
    expect(await rawStatus(port, "/%2e%2e/secret.txt")).toBe(404);
    expect(await rawStatus(port, "/_next/..%2f..%2fsecret.txt")).toBe(404);
  });

  test("any other path is 404 and any other method is 405", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const headers = asOwner(m.home);
    expect((await fetch(`${base}/api/machines/x`, { headers })).status).toBe(
      404
    );
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
    expect(
      (await fetch(`${base}/api/machines`, { method: "DELETE", headers }))
        .status
    ).toBe(405);
  });

  test("requests read the last snapshot and never probe", async () => {
    const before = m.fetches.length;
    await fetch(`${base}/api/machines`, { headers: asOwner(m.home) });
    await fetch(`${base}/`);
    expect(m.fetches.length).toBe(before);
  });
});

test("without a built page, / says how to build it and the JSON still answers", async () => {
  const port = await Effect.runPromise(freePort);
  const empty = mkdtempSync(join(tmpdir(), "devbox-hub-empty-"));
  const home = freshHome();

  const running = start({ HOME: home }, [
    "hub",
    "--port",
    String(port),
    "--ui",
    empty,
  ]);

  for (let i = 0; i < 100 && !running.err().includes("hub:"); i += 1) {
    await Bun.sleep(20);
  }

  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(404);
    expect(await page.text()).toContain("bun run build");
    const headers = asOwner(home);
    expect(
      (await fetch(`http://127.0.0.1:${port}/api/machines`, { headers })).status
    ).toBe(200);
  } finally {
    await running.stop();
  }
});

test("the hub closes its port when stopped", async () => {
  const port = await Effect.runPromise(freePort);
  const home = freshHome();
  const running = start({ HOME: home }, ["hub", "--port", String(port)]);

  for (let i = 0; i < 100 && !running.err().includes("hub:"); i += 1) {
    await Bun.sleep(20);
  }

  const headers = asOwner(home);
  expect(
    (await fetch(`http://127.0.0.1:${port}/api/machines`, { headers })).status
  ).toBe(200);
  await running.stop();
  await expect(
    fetch(`http://127.0.0.1:${port}/api/machines`)
  ).rejects.toThrow();
});

test("a port in use fails with a hint", async () => {
  const taken = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });

  try {
    const r = await devbox({ HOME: freshHome() }, [
      "hub",
      "--port",
      String(taken.port),
    ]);

    expect(r.code).toBe(1);
    expect(r.err).toContain(`cannot listen on 127.0.0.1:${taken.port}`);
    expect(r.err).toContain("--port");
  } finally {
    await taken.stop(true);
  }
});

const sample = (
  generatedAt: string,
  states: Record<string, MachineState>,
  latency: Record<string, number | null> = {}
): Snapshot => ({
  generatedAt,
  tailscale: true,
  machines: Object.entries(states).map(([name, state]) => ({
    name,
    here: false,
    kind: "computer",
    state,
    tailscale: null,
    t3:
      latency[name] === undefined
        ? null
        : {
            environmentId: `env-${name}`,
            label: name,
            version: "0.2.0",
            url: `http://${name}.tail1234.ts.net:3773`,
            latencyMs: latency[name],
            link: null,
          },
    vitals: null,
    spoke: null,
  })),
});

describe("history", () => {
  const T0 = "2026-11-27T00:00:00.000Z";

  test("starts with one character and rounded latency per machine", () => {
    expect(
      nextHistory(
        undefined,
        sample(T0, { a: "t3", b: "online", c: "offline" }, { a: 14.6 })
      )
    ).toEqual({
      sampleSeconds: 60,
      startedAt: T0,
      states: { a: "2", b: "1", c: "0" },
      latency: { a: [15], b: [null], c: [null] },
    });
  });

  test("pads a machine seen late with null, and sets null when one is missing from a sample", () => {
    let history = nextHistory(
      undefined,
      sample(T0, { a: "t3", b: "online" }, { a: 10 })
    );

    history = nextHistory(
      history,
      sample("2026-11-27T00:01:00.000Z", { a: "online" })
    );
    history = nextHistory(
      history,
      sample(
        "2026-11-27T00:02:00.000Z",
        { a: "t3", c: "t3" },
        { a: 22, c: 38.2 }
      )
    );
    expect(history).toEqual({
      sampleSeconds: 60,
      startedAt: T0,
      states: { a: "212", b: "1  ", c: "  2" },
      latency: {
        a: [10, null, 22],
        b: [null, null, null],
        c: [null, null, 38],
      },
    });
  });

  test("keeps the newest 1440 samples for both states and latency", () => {
    const full = {
      sampleSeconds: 60,
      startedAt: T0,
      states: { a: "0".repeat(HISTORY_LIMIT) },
      latency: { a: Array<number | null>(HISTORY_LIMIT).fill(5) },
    };

    const next = nextHistory(
      full,
      sample("2026-11-28T00:00:00.000Z", { a: "t3" }, { a: 42 })
    );

    expect(HISTORY_LIMIT).toBe(1440);
    expect(next.states.a).toBe(`${"0".repeat(1439)}2`);
    expect(next.latency.a).toHaveLength(HISTORY_LIMIT);
    expect(next.latency.a?.[0]).toBe(5);
    expect(next.latency.a?.at(-1)).toBe(42);
  });

  test("forgets a machine from states and latency once the whole window is blank", () => {
    const old = {
      sampleSeconds: 60,
      startedAt: T0,
      states: {
        a: "2".repeat(HISTORY_LIMIT),
        gone: `1${" ".repeat(HISTORY_LIMIT - 1)}`,
      },
      latency: {
        a: Array<number | null>(HISTORY_LIMIT).fill(12),
        gone: [18, ...Array<null>(HISTORY_LIMIT - 1).fill(null)],
      },
    };

    const next = nextHistory(old, sample(T0, { a: "t3" }, { a: 14 }));
    expect(Object.keys(next.states)).toEqual(["a"]);
    expect(Object.keys(next.latency)).toEqual(["a"]);
  });

  test("fills a restart gap with null and trims to the limit", () => {
    const text = serialize(
      {
        history: {
          sampleSeconds: 60,
          startedAt: T0,
          states: { a: "2222", gone: "1   " },
          latency: { a: [10, 20, 30, 40], gone: [12, null, null, null] },
        },
        watch: { announced: { a: "t3" }, pending: {} },
      },
      T0
    );

    const full = Option.getOrThrow(
      restore(text, Date.parse("2026-11-27T00:03:10.000Z"), HISTORY_LIMIT)
    );

    expect(full.history.latency).toEqual({
      a: [10, 20, 30, 40, null, null, null],
      gone: [12, null, null, null, null, null, null],
    });

    const trimmed = Option.getOrThrow(
      restore(text, Date.parse("2026-11-27T00:03:00.000Z"), 5)
    );

    expect(trimmed.history.states).toEqual({ a: "22   " });
    expect(trimmed.history.latency).toEqual({ a: [30, 40, null, null, null] });
  });

  test("restores an older state file without latency and aligns on the next sample", () => {
    const legacy = JSON.stringify({
      savedAt: T0,
      history: { sampleSeconds: 60, startedAt: T0, states: { a: "22" } },
      watch: { announced: { a: "t3" }, pending: {} },
    });

    const resumed = Option.getOrThrow(
      restore(legacy, Date.parse("2026-11-27T00:02:00.000Z"), HISTORY_LIMIT)
    );

    expect(resumed.history.states).toEqual({ a: "22  " });
    expect(resumed.history.latency).toEqual({});

    const next = nextHistory(
      resumed.history,
      sample("2026-11-27T00:02:00.000Z", { a: "t3" }, { a: 27 })
    );

    expect(next.states).toEqual({ a: "22  2" });
    expect(next.latency).toEqual({ a: [null, null, null, null, 27] });
  });
});
