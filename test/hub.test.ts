import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { HISTORY_LIMIT, type HubSnapshot, nextHistory } from "../src/hub/hub.ts";
import type { Machine, MachineState, Snapshot } from "../src/hub/machines.ts";
import { freePort } from "../src/machine/proxy.ts";
import { makeMachine } from "./support/host.ts";
import { devbox, start } from "./support/run.ts";

const SNEAKY = `</script><script>alert(1)</script>$&$'`;

const sneakyComputer = () => {
  const m = makeMachine();
  m.binaries.add("tailscale");
  m.binaries.add("t3");
  m.respond = (argv) => {
    if (argv[0] === "tailscale")
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
    if (argv[1] === "environment")
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
    return undefined;
  };
  m.pages.set(
    "http://100.64.0.21:3773/.well-known/t3/environment",
    JSON.stringify({ environmentId: "env-7", label: "edge-7", serverVersion: "0.2.0" }),
  );
  return m;
};

describe("devbox hub", async () => {
  const m = sneakyComputer();
  const port = await Effect.runPromise(freePort);
  const running = start({ HOME: m.home }, ["hub", "--port", String(port)], { host: m.host });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100 && !running.err().includes("hub:"); i += 1) await Bun.sleep(20);
  afterAll(() => running.stop());

  test("logs the URL it listens on", () => {
    expect(running.err()).toContain(`hub: http://127.0.0.1:${port}/`);
  });

  test("/api/machines serves the snapshot with one sample of history", async () => {
    const response = await fetch(`${base}/api/machines`);
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
    });
  });

  test("/ serves the page with the same snapshot, and a label cannot close its script tag", async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).not.toContain("__DEVBOX_SNAPSHOT__");
    expect(html).not.toContain("<script>alert(1)");
    const embedded = /<script id="snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1];
    const api = await (await fetch(`${base}/api/machines`)).json();
    expect(JSON.parse(embedded ?? "null")).toEqual(api);
  });

  test("any other path is 404 and any other method is 405", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/machines/x`)).status).toBe(404);
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/machines`, { method: "DELETE" })).status).toBe(405);
  });

  test("requests read the last snapshot and never probe", async () => {
    const before = m.fetches.length;
    await fetch(`${base}/api/machines`);
    await fetch(`${base}/`);
    expect(m.fetches.length).toBe(before);
  });
});

test("the hub closes its port when stopped", async () => {
  const port = await Effect.runPromise(freePort);
  const running = start({}, ["hub", "--port", String(port)]);
  for (let i = 0; i < 100 && !running.err().includes("hub:"); i += 1) await Bun.sleep(20);
  expect((await fetch(`http://127.0.0.1:${port}/api/machines`)).status).toBe(200);
  await running.stop();
  await expect(fetch(`http://127.0.0.1:${port}/api/machines`)).rejects.toThrow();
});

test("a port in use fails with a hint", async () => {
  const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  try {
    const r = await devbox({}, ["hub", "--port", String(taken.port)]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`cannot listen on 127.0.0.1:${taken.port}`);
    expect(r.err).toContain("--port");
  } finally {
    await taken.stop(true);
  }
});

const sample = (generatedAt: string, states: Record<string, MachineState>): Snapshot => ({
  generatedAt,
  tailscale: true,
  machines: Object.entries(states).map(([name, state]) => ({
    name,
    here: false,
    state,
    tailscale: null,
    t3: null,
  })),
});

describe("history", () => {
  const T0 = "2026-11-27T00:00:00.000Z";

  test("starts with one character per machine", () => {
    expect(nextHistory(undefined, sample(T0, { a: "t3", b: "online", c: "offline" }))).toEqual({
      sampleSeconds: 60,
      startedAt: T0,
      states: { a: "2", b: "1", c: "0" },
    });
  });

  test("pads a machine seen late, and blanks one missing from a sample", () => {
    let history = nextHistory(undefined, sample(T0, { a: "t3", b: "online" }));
    history = nextHistory(history, sample("2026-11-27T00:01:00.000Z", { a: "online" }));
    history = nextHistory(history, sample("2026-11-27T00:02:00.000Z", { a: "t3", c: "offline" }));
    expect(history).toEqual({
      sampleSeconds: 60,
      startedAt: T0,
      states: { a: "212", b: "1  ", c: "  0" },
    });
  });

  test("keeps the newest 1440 samples", () => {
    const full = { sampleSeconds: 60, startedAt: T0, states: { a: "0".repeat(HISTORY_LIMIT) } };
    const next = nextHistory(full, sample("2026-11-28T00:00:00.000Z", { a: "t3" }));
    expect(HISTORY_LIMIT).toBe(1440);
    expect(next.states.a).toBe(`${"0".repeat(1439)}2`);
  });

  test("forgets a machine once the whole window is blank", () => {
    const old = {
      sampleSeconds: 60,
      startedAt: T0,
      states: { a: "2".repeat(HISTORY_LIMIT), gone: `1${" ".repeat(HISTORY_LIMIT - 1)}` },
    };
    expect(Object.keys(nextHistory(old, sample(T0, { a: "t3" })).states)).toEqual(["a"]);
  });
});
