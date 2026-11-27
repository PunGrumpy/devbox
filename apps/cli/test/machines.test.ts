import { describe, expect, test } from "bun:test";

import type { Ran } from "../src/machine/host.ts";
import { makeMachine } from "./support/host.ts";
import { devbox } from "./support/run.ts";

const ok = (stdout: string): Ran => ({ code: 0, stdout, stderr: "" });
const NEVER = "0001-01-01T00:00:00Z";

const node = (
  name: string,
  ip: string,
  extra: Record<string, unknown> = {}
) => ({
  HostName: name,
  DNSName: `${name.toLowerCase()}.tail1234.ts.net.`,
  TailscaleIPs: [ip, "fd7a:115c:a1e0::15"],
  OS: "linux",
  Online: true,
  LastSeen: NEVER,
  ...extra,
});

const status = (self: object, peers: readonly object[]) =>
  JSON.stringify({
    BackendState: "Running",
    Self: self,
    Peer: Object.fromEntries(peers.map((peer, i) => [`nodekey:${i}`, peer])),
  });

const descriptor = (environmentId: string, label: string) =>
  JSON.stringify({
    environmentId,
    label,
    platform: { os: "linux" },
    serverVersion: "0.2.0",
  });

const t3Link = (
  environmentId: string,
  label: string,
  linkStatus = "reachable"
) => ({
  environmentId,
  label,
  urls: [`http://${label.toLowerCase()}.tail1234.ts.net:3773/`],
  access: "full-access",
  linkedAt: "2026-11-01T00:00:00.000Z",
  expiresAt: "2026-12-01T00:00:00.000Z",
  lastReachedAt: null,
  lastError: null,
  status: linkStatus,
});

const page = (ip: string, port = 3773) =>
  `http://${ip}:${port}/.well-known/t3/environment`;

/** A computer with Tailscale (or not), `t3` on PATH, and pages that answer. */
const computer = (
  options: {
    tailscale?: string;
    tailscaleBin?: string;
    links?: readonly object[];
    pages?: Record<string, string>;
  } = {}
) => {
  const m = makeMachine();
  const { tailscale, tailscaleBin = "tailscale", links = [] } = options;

  if (tailscale !== undefined) {
    m.binaries.add(tailscaleBin);
  }

  m.binaries.add("t3");
  m.pages = new Map(Object.entries(options.pages ?? {}));
  m.respond = (argv) => {
    if (
      argv[0] === tailscaleBin &&
      argv[1] === "status" &&
      tailscale !== undefined
    ) {
      return ok(tailscale);
    }

    if (argv[1] === "environment" && argv[2] === "list") {
      return ok(JSON.stringify(links));
    }

    return undefined;
  };

  return m;
};

const machinesJson = async (
  m: ReturnType<typeof makeMachine>,
  ...args: string[]
) => {
  const r = await devbox({ HOME: m.home }, ["machines", "--json", ...args], {
    host: m.host,
  });

  expect(r.code).toBe(0);

  return { ...r, json: JSON.parse(r.out) };
};

describe("devbox machines --json", () => {
  test("merges probed nodes with links by environment id, by label, and on their own", async () => {
    const m = computer({
      tailscale: status(node("edge-7", "100.64.0.21"), [
        node("edge-8", "100.64.0.22"),
        node("EDGE-9", "100.64.0.23"),
      ]),
      pages: {
        [page("100.64.0.21")]: descriptor("env-7", "edge-7"),
        [page("100.64.0.22")]: descriptor("env-8", "edge-8"),
      },
      links: [
        t3Link("env-8", "edge-8"),
        t3Link("env-9", "edge-9", "unreachable"),
        t3Link("env-x", "laptop-3"),
      ],
    });

    const { json, out } = await machinesJson(m);
    expect(Object.keys(json)).toEqual(["generatedAt", "tailscale", "machines"]);
    expect(new Date(json.generatedAt).toISOString()).toBe(json.generatedAt);
    expect(json.tailscale).toBe(true);
    expect(out).toBe(`${JSON.stringify(json, null, 2)}\n`);
    expect(json.machines).toEqual([
      {
        name: "edge-7",
        here: true,
        kind: "computer",
        state: "t3",
        tailscale: {
          ip: "100.64.0.21",
          dns: "edge-7.tail1234.ts.net",
          os: "linux",
          online: true,
          lastSeen: null,
        },
        t3: {
          environmentId: "env-7",
          label: "edge-7",
          version: "0.2.0",
          url: "http://edge-7.tail1234.ts.net:3773",
          latencyMs: 12,
          link: null,
        },
        vitals: null,
        spoke: null,
      },
      {
        name: "edge-8",
        here: false,
        kind: "computer",
        state: "t3",
        tailscale: {
          ip: "100.64.0.22",
          dns: "edge-8.tail1234.ts.net",
          os: "linux",
          online: true,
          lastSeen: null,
        },
        t3: {
          environmentId: "env-8",
          label: "edge-8",
          version: "0.2.0",
          url: "http://edge-8.tail1234.ts.net:3773",
          latencyMs: 12,
          link: {
            status: "reachable",
            access: "full-access",
            expiresAt: "2026-12-01T00:00:00.000Z",
            urls: ["http://edge-8.tail1234.ts.net:3773/"],
          },
        },
        vitals: null,
        spoke: null,
      },
      {
        name: "laptop-3",
        here: false,
        kind: "remote",
        state: "t3",
        tailscale: null,
        t3: {
          environmentId: "env-x",
          label: "laptop-3",
          version: null,
          url: null,
          latencyMs: null,
          link: {
            status: "reachable",
            access: "full-access",
            expiresAt: "2026-12-01T00:00:00.000Z",
            urls: ["http://laptop-3.tail1234.ts.net:3773/"],
          },
        },
        vitals: null,
        spoke: null,
      },
      {
        name: "EDGE-9",
        here: false,
        kind: "computer",
        state: "online",
        tailscale: {
          ip: "100.64.0.23",
          dns: "edge-9.tail1234.ts.net",
          os: "linux",
          online: true,
          lastSeen: null,
        },
        t3: {
          environmentId: "env-9",
          label: "edge-9",
          version: null,
          url: null,
          latencyMs: null,
          link: {
            status: "unreachable",
            access: "full-access",
            expiresAt: "2026-12-01T00:00:00.000Z",
            urls: ["http://edge-9.tail1234.ts.net:3773/"],
          },
        },
        vitals: null,
        spoke: null,
      },
    ]);
    expect(m.calls).toContainEqual(["t3", "environment", "list", "--json"]);
  });

  test("a label match never takes a node that already has T3", async () => {
    const m = computer({
      tailscale: status(node("edge-7", "100.64.0.21"), []),
      pages: { [page("100.64.0.21")]: descriptor("env-7", "edge-7") },
      links: [t3Link("env-old", "edge-7")],
    });

    const { json } = await machinesJson(m);
    expect(
      json.machines.map(
        (x: { name: string; t3: { environmentId: string } }) => [
          x.name,
          x.t3.environmentId,
        ]
      )
    ).toEqual([
      ["edge-7", "env-7"],
      ["edge-7", "env-old"],
    ]);
  });

  test("orders this machine first, then T3, online and offline, then names ignoring case", async () => {
    const m = computer({
      tailscale: status(node("edge-7", "100.64.0.21"), [
        node("Zulu", "100.64.0.30"),
        node("alpha", "100.64.0.31"),
        node("Charlie", "100.64.0.32", { Online: false }),
        node("bravo", "100.64.0.33", { Online: false }),
      ]),
      pages: { [page("100.64.0.30")]: descriptor("env-z", "Zulu") },
      links: [t3Link("env-d", "delta"), t3Link("env-e", "echo", "unreachable")],
    });

    const { json } = await machinesJson(m);
    expect(
      json.machines.map(
        (x: { name: string; state: string }) => `${x.name}:${x.state}`
      )
    ).toEqual([
      "edge-7:online",
      "delta:t3",
      "Zulu:t3",
      "alpha:online",
      "bravo:offline",
      "Charlie:offline",
      "echo:offline",
    ]);
  });

  test("an offline node keeps a real LastSeen and is not probed", async () => {
    const m = computer({
      tailscale: status(node("edge-7", "100.64.0.21"), [
        node("edge-8", "100.64.0.22", {
          Online: false,
          LastSeen: "2026-11-26T08:15:00Z",
        }),
        node("edge-9", "100.64.0.23", { Online: false }),
      ]),
      pages: { [page("100.64.0.22")]: descriptor("env-8", "edge-8") },
    });

    const { json } = await machinesJson(m);

    const seen = Object.fromEntries(
      json.machines.map(
        (x: { name: string; tailscale: { lastSeen: string | null } }) => [
          x.name,
          x.tailscale.lastSeen,
        ]
      )
    );

    expect(seen).toEqual({
      "edge-7": null,
      "edge-8": "2026-11-26T08:15:00Z",
      "edge-9": null,
    });
    expect(json.machines[1].state).toBe("offline");
    expect(m.fetches.filter((url) => !url.endsWith("/api/spoke"))).toEqual([
      page("100.64.0.21"),
    ]);
    expect(m.fetches.some((url) => url.includes("100.64.0.22"))).toBe(false);
  });

  test("drops phones and TVs, which cannot run T3 Code", async () => {
    const m = computer({
      tailscale: status(node("edge-7", "100.64.0.21"), [
        node("phone", "100.64.0.40", { OS: "iOS" }),
        node("pixel", "100.64.0.41", { OS: "android" }),
        node("tv", "100.64.0.42", { OS: "tvOS" }),
        node("mac-1", "100.64.0.43", { OS: "macOS" }),
      ]),
      pages: { [page("100.64.0.40")]: descriptor("env-p", "phone") },
    });

    const { json } = await machinesJson(m);
    expect(json.machines.map((x: { name: string }) => x.name)).toEqual([
      "edge-7",
      "mac-1",
    ]);
    expect(m.fetches).not.toContain(page("100.64.0.40"));
  });

  test("uses tailscale.exe when tailscale is not on PATH, as under WSL", async () => {
    const m = computer({
      tailscale: status(node("edge-7", "100.64.0.21"), [
        node("edge-8", "100.64.0.22"),
      ]),
      tailscaleBin: "tailscale.exe",
    });

    const { json } = await machinesJson(m);
    expect(json.tailscale).toBe(true);
    expect(json.machines.map((x: { name: string }) => x.name)).toEqual([
      "edge-7",
      "edge-8",
    ]);
    expect(m.calls).toContainEqual(["tailscale.exe", "status", "--json"]);
  });

  test("without Tailscale it lists this machine, probed on loopback", async () => {
    const m = computer({
      pages: { [page("127.0.0.1", 3800)]: descriptor("env-7", "edge-7") },
    });

    const { json } = await machinesJson(m, "--t3-port", "3800");
    expect(json.tailscale).toBe(false);
    expect(json.machines).toEqual([
      {
        name: "box-1.example.internal",
        here: true,
        kind: "computer",
        state: "t3",
        tailscale: null,
        t3: {
          environmentId: "env-7",
          label: "edge-7",
          version: "0.2.0",
          url: "http://127.0.0.1:3800",
          latencyMs: 12,
          link: null,
        },
        vitals: null,
        spoke: null,
      },
    ]);
  });

  test("a Tailscale that fails counts as no Tailscale, and the table says so on stderr", async () => {
    const m = computer();
    m.binaries.add("tailscale");
    const r = await devbox({ HOME: m.home }, ["machines"], { host: m.host });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toContain("Tailscale did not answer");
    expect(r.err).toMatch(
      /machine\s+kind\s+state\s+where\s+T3 Code\s+agent link/
    );
    expect(r.err).toMatch(
      /box-1\.example\.internal \(here\)\s+computer\s+online/
    );
  });

  test("--json says nothing on stderr when Tailscale does not answer", async () => {
    const { json, err } = await machinesJson(computer());
    expect(json.tailscale).toBe(false);
    expect(json.machines.map((x: { state: string }) => x.state)).toEqual([
      "online",
    ]);
    expect(err).toBe("");
  });
});

const LINKS = JSON.stringify([t3Link("env-8", "edge-8")]);

const linkedNames = async (
  m: ReturnType<typeof makeMachine>,
  ...args: string[]
) =>
  (await machinesJson(m, ...args)).json.machines.map(
    (x: { name: string }) => x.name
  );

const bare = () => {
  const m = makeMachine();
  m.respond = (argv) => (argv[1] === "environment" ? ok(LINKS) : undefined);

  return m;
};

describe("which t3 lists the links", () => {
  test("--t3 wins", async () => {
    const m = bare();
    m.binaries.add("t3");
    expect(await linkedNames(m, "--t3", "/opt/t3/bin/t3")).toContain("edge-8");
    expect(m.calls).toContainEqual([
      "/opt/t3/bin/t3",
      "environment",
      "list",
      "--json",
    ]);
    expect(m.calls).not.toContainEqual(["t3", "environment", "list", "--json"]);
  });

  test("without t3 on PATH it uses the running T3 server's binary", async () => {
    const m = bare();
    m.processes = [
      { pid: 10, argv: ["/usr/bin/t3-helper", "serve"] },
      {
        pid: 11,
        argv: [
          "/home/agent/.t3/wsl-runtime/sha256-ab/t3",
          "--bootstrap-fd",
          "0",
        ],
      },
    ];
    expect(await linkedNames(m)).toContain("edge-8");
    expect(m.calls).toContainEqual([
      "/home/agent/.t3/wsl-runtime/sha256-ab/t3",
      "environment",
      "list",
      "--json",
    ]);
  });

  test("with no t3 anywhere it lists machines without links", async () => {
    const m = bare();
    expect(await linkedNames(m)).toEqual(["box-1.example.internal"]);
    expect(m.calls.some((c) => c[1] === "environment")).toBe(false);
  });

  test("a t3 that fails or prints something else adds no links", async () => {
    const m = bare();
    m.binaries.add("t3");
    m.respond = (argv) =>
      argv[1] === "environment" ? ok("Not signed in") : undefined;
    expect(await linkedNames(m)).toEqual(["box-1.example.internal"]);
  });
});

describe("the kind of a machine", () => {
  const withPlatform = (environmentId: string, label: string, os: string) =>
    JSON.stringify({
      environmentId,
      label,
      serverVersion: "0.2.0",
      platform: { os },
    });

  test("comes from the system Tailscale reports, and WSL from what T3 Code says it runs on", async () => {
    const m = computer({
      tailscale: status(node("studio", "100.64.0.10", { OS: "macOS" }), [
        node("tower", "100.64.0.11", { OS: "windows" }),
        node("wsl-pc", "100.64.0.12", { OS: "windows" }),
        node("edge-7", "100.64.0.21"),
      ]),
      links: [t3Link("env-cloud", "cloud-box")],
      pages: {
        [page("100.64.0.12")]: withPlatform("env-wsl", "wsl-pc", "linux"),
      },
    });

    const { json } = await machinesJson(m);
    expect(
      Object.fromEntries(
        json.machines.map((x: { name: string; kind: string }) => [
          x.name,
          x.kind,
        ])
      )
    ).toEqual({
      studio: "mac",
      tower: "windows",
      "wsl-pc": "wsl",
      "edge-7": "computer",
      "cloud-box": "remote",
    });
  });

  test("a virtual machine is told apart only when it is this one", async () => {
    const m = computer({
      tailscale: status(node("edge-7", "100.64.0.21"), [
        node("edge-8", "100.64.0.22"),
      ]),
    });

    const { respond } = m;
    m.respond = (argv) =>
      argv[0] === "systemd-detect-virt" ? ok("kvm\n") : respond(argv);
    const { json } = await machinesJson(m);
    expect(
      json.machines.map((x: { name: string; kind: string }) => [x.name, x.kind])
    ).toEqual([
      ["edge-7", "vm"],
      ["edge-8", "computer"],
    ]);
  });
});
