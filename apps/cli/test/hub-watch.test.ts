import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Option } from "effect";

import { HISTORY_LIMIT, type HubSnapshot, stateFile } from "../src/hub/hub.ts";
import type { MachineState, Snapshot } from "../src/hub/machines.ts";
import { restore, serialize } from "../src/hub/saved.ts";
import {
  nextWatch,
  sentence,
  type Watch,
  webhookBody,
} from "../src/hub/watch.ts";
import { freePort } from "../src/machine/proxy.ts";
import { makeMachine } from "./support/host.ts";
import { asOwner, start } from "./support/run.ts";

const T0 = "2026-11-27T00:00:00.000Z";

const sample = (states: Record<string, MachineState>): Snapshot => ({
  generatedAt: T0,
  tailscale: true,
  machines: Object.entries(states).map(([name, state]) => ({
    name,
    here: false,
    kind: "computer",
    state,
    tailscale: null,
    t3: null,
    vitals: null,
    spoke: null,
  })),
});

/** Feeds samples to the reducer in turn and returns what each one announced. */
const announce = (...samples: ReadonlyArray<Record<string, MachineState>>) => {
  let watch: Watch | undefined;
  return samples.map((states) => {
    const next = nextWatch(watch, sample(states));
    watch = next.watch;
    return next.notices.map(sentence);
  });
};

describe("what the hub announces", () => {
  test("the first sample only sets the baseline", () => {
    expect(announce({ a: "offline", b: "t3" })).toEqual([[]]);
  });

  test("one missed probe is not news", () => {
    expect(
      announce({ a: "t3" }, { a: "offline" }, { a: "t3" }, { a: "t3" })
    ).toEqual([[], [], [], []]);
  });

  test("a state that holds for two samples is announced once", () => {
    expect(
      announce(
        { a: "t3" },
        { a: "offline" },
        { a: "offline" },
        { a: "offline" }
      )
    ).toEqual([[], [], ["a went offline"], []]);
  });

  test("a recovery is announced too", () => {
    expect(
      announce(
        { a: "t3" },
        { a: "offline" },
        { a: "offline" },
        { a: "t3" },
        { a: "t3" }
      ).at(-1)
    ).toEqual(["a is back online, and T3 Code answers"]);
  });

  test("T3 Code stopping and answering again have their own words", () => {
    expect(
      announce(
        { a: "t3" },
        { a: "online" },
        { a: "online" },
        { a: "t3" },
        { a: "t3" }
      )
    ).toEqual([
      [],
      [],
      ["T3 Code stopped answering on a"],
      [],
      ["T3 Code answers on a again"],
    ]);
  });

  test("a machine seen later sets its baseline silently, and one that leaves is remembered", () => {
    expect(
      announce(
        { a: "t3" },
        { a: "t3", b: "offline" },
        { b: "offline" },
        { a: "t3" }
      )
    ).toEqual([[], [], [], []]);
  });
});

describe("what a webhook is sent", () => {
  test("Discord and Slack take JSON, and anything else takes the sentence", () => {
    expect(
      webhookBody(
        new URL("https://discord.com/api/webhooks/1/x"),
        "a went offline"
      )
    ).toEqual({
      body: '{"content":"a went offline"}',
      contentType: "application/json",
    });
    expect(
      webhookBody(
        new URL("https://hooks.slack.com/services/x"),
        "a went offline"
      )
    ).toEqual({
      body: '{"text":"a went offline"}',
      contentType: "application/json",
    });
    expect(
      webhookBody(
        new URL("https://ntfy.example.com/machines"),
        "a went offline"
      )
    ).toEqual({
      body: "a went offline",
      contentType: "text/plain; charset=utf-8",
    });
  });
});

describe("what a hub takes over when it starts again", () => {
  const saved = (savedAt: string) =>
    serialize(
      {
        history: {
          sampleSeconds: 60,
          startedAt: T0,
          states: { a: "2222", gone: "1   " },
          latency: {},
        },
        watch: { announced: { a: "t3" }, pending: {} },
      },
      savedAt
    );
  const at = (iso: string) => Date.parse(iso);

  test("the time it was down becomes unknown samples", () => {
    const resumed = restore(
      saved(T0),
      at("2026-11-27T00:03:10.000Z"),
      HISTORY_LIMIT
    );
    expect(Option.getOrThrow(resumed).history.states).toEqual({
      a: "2222   ",
      gone: "1      ",
    });
    expect(Option.getOrThrow(resumed).watch.announced).toEqual({ a: "t3" });
  });

  test("a machine whose whole window is unknown is forgotten", () => {
    const resumed = restore(saved(T0), at("2026-11-27T00:03:00.000Z"), 5);
    expect(Option.getOrThrow(resumed).history.states).toEqual({ a: "22   " });
  });

  test("a file a day old, from the future, or broken gives nothing", () => {
    expect(
      Option.isNone(
        restore(saved(T0), at("2026-11-28T00:00:00.000Z"), HISTORY_LIMIT)
      )
    ).toBe(true);
    expect(
      Option.isNone(
        restore(saved(T0), at("2026-11-26T23:00:00.000Z"), HISTORY_LIMIT)
      )
    ).toBe(true);
    expect(Option.isNone(restore("{", at(T0), HISTORY_LIMIT))).toBe(true);
  });
});

const REGISTRY = "https://registry.npmjs.org/t3/nightly";

const onlineComputer = () => {
  const m = makeMachine();
  m.binaries.add("tailscale");
  m.respond = (argv) =>
    argv[0] === "tailscale"
      ? {
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
        }
      : undefined;
  m.pages.set(REGISTRY, JSON.stringify({ name: "t3", version: "0.3.0" }));
  return m;
};

const running = async (
  m: ReturnType<typeof makeMachine>,
  env: Record<string, string> = {}
) => {
  const port = await Effect.runPromise(freePort);
  const empty = mkdtempSync(join(tmpdir(), "devbox-hub-ui-"));
  const hub = start(
    { HOME: m.home, ...env },
    ["hub", "--port", String(port), "--ui", empty],
    {
      host: m.host,
    }
  );
  for (let i = 0; i < 100 && !hub.err().includes("hub:"); i += 1)
    await Bun.sleep(20);
  const answered = await fetch(`http://127.0.0.1:${port}/api/machines`, {
    headers: asOwner(m.home),
  });
  const json = (await answered.json()) as HubSnapshot;
  return { hub, json };
};

describe("devbox hub over a restart", () => {
  test("it reports the newest T3 Code and saves its history", async () => {
    const m = onlineComputer();
    const { hub, json } = await running(m);
    await hub.stop();
    expect(json.latest).toEqual({ t3: "0.3.0" });
    const file = JSON.parse(readFileSync(stateFile(m.home), "utf8"));
    expect(file.history.states).toEqual({ "edge-7": "1" });
    expect(file.watch.announced).toEqual({ "edge-7": "online" });
  });

  test("it carries on from the saved history and announces a change that has now held", async () => {
    const m = onlineComputer();
    mkdirSync(dirname(stateFile(m.home)), { recursive: true });
    writeFileSync(
      stateFile(m.home),
      serialize(
        {
          history: {
            sampleSeconds: 60,
            startedAt: T0,
            states: { "edge-7": "000" },
            latency: {},
          },
          watch: {
            announced: { "edge-7": "offline" },
            pending: { "edge-7": { state: "online", samples: 1 } },
          },
        },
        new Date().toISOString()
      )
    );
    const { hub, json } = await running(m, {
      DEVBOX_HUB_NOTIFY: "https://ntfy.example.com/hub",
    });
    await hub.stop();
    expect(json.history.states).toEqual({ "edge-7": "0001" });
    expect(m.posts).toEqual([
      {
        url: "https://ntfy.example.com/hub",
        body: "edge-7 is back online",
        contentType: "text/plain; charset=utf-8",
      },
    ]);
  });

  test("a webhook that fails is reported without its address, and the hub still answers", async () => {
    const m = onlineComputer();
    m.webhookUp = false;
    mkdirSync(dirname(stateFile(m.home)), { recursive: true });
    writeFileSync(
      stateFile(m.home),
      serialize(
        {
          history: {
            sampleSeconds: 60,
            startedAt: T0,
            states: {},
            latency: {},
          },
          watch: {
            announced: { "edge-7": "offline" },
            pending: { "edge-7": { state: "online", samples: 1 } },
          },
        },
        new Date().toISOString()
      )
    );
    const { hub, json } = await running(m, {
      DEVBOX_HUB_NOTIFY: "https://ntfy.example.com/secret",
    });
    const logged = hub.err();
    await hub.stop();
    expect(json.machines).toHaveLength(1);
    expect(logged).toContain("a notification could not be sent");
    expect(logged).not.toContain("ntfy.example.com");
  });

  test("a value that is not a URL sends nothing and says so", async () => {
    const m = onlineComputer();
    const { hub } = await running(m, { DEVBOX_HUB_NOTIFY: "not a url" });
    const logged = hub.err();
    await hub.stop();
    expect(logged).toContain("DEVBOX_HUB_NOTIFY is not a URL");
    expect(m.posts).toEqual([]);
  });
});
