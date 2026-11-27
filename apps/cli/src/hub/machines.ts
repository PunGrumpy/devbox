import { DateTime, Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";

import { Port } from "../machine/config.ts";
import { Host } from "../machine/host.ts";
import { LINUX_T3_SERVER } from "../migrate/t3-process.ts";
import { Output } from "../output.ts";
import type { Column, Tone } from "../output.ts";
import { SPOKE_PORT, SpokeAnswer } from "../spoke/vitals.ts";
import type { Vitals } from "../spoke/vitals.ts";

export type { Vitals } from "../spoke/vitals.ts";

export type MachineState = "t3" | "online" | "offline";

export interface Tailnet {
  readonly ip: string;
  readonly dns: string;
  readonly os: string;
  readonly online: boolean;
  readonly lastSeen: string | null;
}

export interface LinkSummary {
  readonly status: string;
  readonly access: string;
  readonly expiresAt: string;
  readonly urls: readonly string[];
}

export interface T3 {
  readonly environmentId: string;
  readonly label: string;
  readonly version: string | null;
  readonly url: string | null;
  readonly latencyMs: number | null;
  readonly link: LinkSummary | null;
}

/**
 * What a machine is, as far as this computer can tell without asking it. Tailscale tells a peer
 * only a machine's name and system, so a virtual machine can be told apart only when it is this
 * one.
 */
export type MachineKind =
  | "mac"
  | "windows"
  | "wsl"
  | "vm"
  | "computer"
  | "remote";

export interface Machine {
  readonly name: string;
  readonly here: boolean;
  readonly kind: MachineKind;
  readonly state: MachineState;
  readonly tailscale: Tailnet | null;
  readonly t3: T3 | null;
  /** Null when no spoke answered. */
  readonly vitals: Vitals | null;
  /** Whether the machine's spoke takes signed requests from this hub, or null when no spoke answered. */
  readonly spoke: "trusted" | "untrusted" | null;
}

export interface Snapshot {
  readonly generatedAt: string;
  readonly tailscale: boolean;
  readonly machines: readonly Machine[];
}

const TailscaleNode = Schema.Struct({
  HostName: Schema.String,
  DNSName: Schema.String,
  TailscaleIPs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  OS: Schema.String,
  Online: Schema.optional(Schema.Boolean),
  LastSeen: Schema.optional(Schema.String),
});

type TailscaleNode = typeof TailscaleNode.Type;

const TailscaleStatus = Schema.fromJsonString(
  Schema.Struct({
    Self: TailscaleNode,
    Peer: Schema.optional(
      Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))
    ),
  })
);

const Descriptor = Schema.fromJsonString(
  Schema.Struct({
    environmentId: Schema.String,
    label: Schema.String,
    serverVersion: Schema.optional(Schema.String),
    platform: Schema.optional(
      Schema.Struct({ os: Schema.optional(Schema.String) })
    ),
  })
);

const T3Link = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  urls: Schema.Array(Schema.String),
  access: Schema.String,
  expiresAt: Schema.String,
  status: Schema.String,
});

export type T3Link = typeof T3Link.Type;

const T3Links = Schema.fromJsonString(Schema.Array(T3Link));

/** A machine as Tailscale (or this host alone) sees it, with what its descriptor said. */
export interface Seen {
  readonly name: string;
  readonly here: boolean;
  readonly tailscale: Tailnet | null;
  readonly t3:
    | (Omit<T3, "link" | "latencyMs"> & { readonly latencyMs: number })
    | null;
  /** The system T3 Code says it runs on, which under WSL is not the one Tailscale reports. */
  readonly platform: string | null;
  /** What the machine's `devbox spoke` answered. */
  readonly spoke: SpokeAnswer | null;
}

/** `systemd-detect-virt` when this machine is not virtual, or has no such command. */
export const BARE_METAL = "none";

const kindOf = (
  machine: Pick<Machine, "here" | "tailscale">,
  platform: string | null,
  virt: string
) => {
  const os = machine.tailscale?.os.toLowerCase();

  if (machine.here && virt === "wsl") {
    return "wsl" satisfies MachineKind;
  }

  if (os === "windows") {
    return (platform === "linux" ? "wsl" : "windows") satisfies MachineKind;
  }

  if (os === "macos") {
    return "mac" satisfies MachineKind;
  }

  if (machine.here) {
    return (virt === BARE_METAL ? "computer" : "vm") satisfies MachineKind;
  }

  return (
    machine.tailscale === null ? "remote" : "computer"
  ) satisfies MachineKind;
};

const CANNOT_RUN_T3 = new Set(["iOS", "android", "tvOS"]);
const UNKNOWN_TIME = "0001-01-01T00:00:00Z";
const RANK: Record<MachineState, number> = { t3: 0, online: 1, offline: 2 };

const compareNames = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });

const summary = (link: T3Link) =>
  ({
    status: link.status,
    access: link.access,
    expiresAt: link.expiresAt,
    urls: link.urls,
  }) satisfies LinkSummary;

const stateOf = (machine: Pick<Machine, "here" | "tailscale" | "t3">) => {
  if (
    machine.t3 !== null &&
    (machine.t3.latencyMs !== null || machine.t3.link?.status === "reachable")
  ) {
    return "t3" satisfies MachineState;
  }

  return (
    machine.here || machine.tailscale?.online === true ? "online" : "offline"
  ) satisfies MachineState;
};

/**
 * A link joins the machine whose descriptor has its environment id, else the tailnet node named
 * like its label that has no T3 yet, else it stands alone.
 */
export const merge = (
  seen: readonly Seen[],
  links: readonly T3Link[],
  virt: string = BARE_METAL,
  hubKey?: string
) => {
  const drafts: ({
    -readonly [
      K in keyof Omit<Machine, "state" | "kind" | "vitals" | "spoke">
    ]: Machine[K];
  } & {
    readonly platform: string | null;
    readonly spoke: SpokeAnswer | null;
  })[] = seen.map((s) => ({
    ...s,
    t3: s.t3 === null ? null : { ...s.t3, link: null },
  }));

  const unmatched: T3Link[] = [];

  for (const link of links) {
    const owner = drafts.find(
      (d) => d.t3?.environmentId === link.environmentId
    );

    if (owner === undefined || owner.t3 === null) {
      unmatched.push(link);
    } else {
      owner.t3 = { ...owner.t3, link: summary(link) };
    }
  }

  for (const link of unmatched) {
    const t3: T3 = {
      environmentId: link.environmentId,
      label: link.label,
      version: null,
      url: null,
      latencyMs: null,
      link: summary(link),
    };

    const node = drafts.find(
      (d) =>
        d.tailscale !== null &&
        d.t3 === null &&
        compareNames(d.name, link.label) === 0
    );

    if (node === undefined) {
      drafts.push({
        t3,
        name: link.label,
        here: false,
        tailscale: null,
        platform: null,
        spoke: null,
      });
    } else {
      node.t3 = t3;
    }
  }

  return drafts
    .map(
      (d) =>
        ({
          name: d.name,
          here: d.here,
          kind: d.spoke?.kind ?? kindOf(d, d.platform, virt),
          state: stateOf(d),
          tailscale: d.tailscale,
          t3: d.t3,
          vitals: d.spoke?.vitals ?? null,
          spoke: trustOf(d.spoke, hubKey),
        }) satisfies Machine
    )
    .toSorted(
      (a, b) =>
        Number(b.here) - Number(a.here) ||
        RANK[a.state] - RANK[b.state] ||
        compareNames(a.name, b.name)
    );
};

const trustOf = (spoke: SpokeAnswer | null, hubKey: string | undefined) => {
  if (spoke === null || hubKey === undefined) {
    return null;
  }

  return (
    spoke.trusts.includes(hubKey) ? "trusted" : "untrusted"
  ) satisfies Machine["spoke"];
};

const tailnetOf = (node: TailscaleNode, here: boolean) => {
  const ips = node.TailscaleIPs ?? [];
  const seenOnline = here || node.Online === true;

  return {
    here,
    name: node.HostName,
    t3: null,
    platform: null,
    spoke: null,
    tailscale: {
      ip: ips.find((ip) => ip.includes(".")) ?? ips[0] ?? "",
      dns: node.DNSName.replace(/\.$/u, ""),
      os: node.OS,
      online: seenOnline,
      lastSeen:
        seenOnline ||
        node.LastSeen === undefined ||
        node.LastSeen === UNKNOWN_TIME
          ? null
          : node.LastSeen,
    },
  } satisfies Seen;
};

const WINDOWS_CLIENT_ON_WSL_PATH = "tailscale.exe";

const tailscaleBinary = Effect.gen(function* () {
  const host = yield* Host;

  if (yield* host.which("tailscale")) {
    return Option.some("tailscale");
  }

  if (yield* host.which(WINDOWS_CLIENT_ON_WSL_PATH)) {
    return Option.some(WINDOWS_CLIENT_ON_WSL_PATH);
  }

  return Option.none<string>();
});

const tailnet = Effect.gen(function* () {
  const host = yield* Host;
  const bin = yield* tailscaleBinary;

  if (Option.isNone(bin)) {
    return Option.none<readonly Seen[]>();
  }

  const ran = yield* host.run([bin.value, "status", "--json"], {
    timeoutMs: 5000,
  });

  if (ran.code !== 0) {
    return Option.none<readonly Seen[]>();
  }

  return Schema.decodeUnknownOption(TailscaleStatus)(ran.stdout).pipe(
    Option.map((status) =>
      [
        { node: status.Self, here: true },
        ...Object.values(status.Peer ?? {}).flatMap((peer) =>
          Option.match(Schema.decodeUnknownOption(TailscaleNode)(peer), {
            onNone: () => [],
            onSome: (node) => [{ node, here: false }],
          })
        ),
      ].flatMap(({ node, here }) =>
        CANNOT_RUN_T3.has(node.OS) ? [] : [tailnetOf(node, here)]
      )
    )
  );
});

export const origin = (address: string, port: number) => {
  const host = address.includes(":") ? `[${address}]` : address;

  return `http://${host}:${port}`;
};

const LOOPBACK = "127.0.0.1";

/**
 * Where a machine's spoke may listen, in the order to ask. This machine's may listen on loopback
 * only, which no other machine can reach.
 */
export const spokeAddresses = (
  machine: Pick<Machine, "here" | "tailscale">
) => {
  const { tailscale } = machine;

  if (tailscale === null) {
    return [LOOPBACK];
  }

  if (!tailscale.online || tailscale.ip === "") {
    return [];
  }

  return machine.here ? [tailscale.ip, LOOPBACK] : [tailscale.ip];
};

const PROBE_MS = 2000;

const askSpoke = (seen: Seen, port: number) =>
  Effect.gen(function* () {
    const host = yield* Host;

    for (const address of spokeAddresses(seen)) {
      const fetched = yield* host.fetchText(
        `${origin(address, port)}/api/spoke`,
        PROBE_MS
      );

      const answer = Option.flatMap(fetched, ({ body }) =>
        Schema.decodeUnknownOption(SpokeAnswer)(body)
      );

      if (Option.isSome(answer)) {
        return answer.value;
      }
    }

    return null;
  });

const probe = (seen: Seen, port: number, spokePort: number) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const { tailscale } = seen;
    const address = tailscale === null ? LOOPBACK : tailscale.ip;

    if (tailscale !== null && (!tailscale.online || address === "")) {
      return seen;
    }

    const [fetched, spoke] = yield* Effect.all(
      [
        host.fetchText(
          `${origin(address, port)}/.well-known/t3/environment`,
          PROBE_MS
        ),
        askSpoke(seen, spokePort),
      ],
      { concurrency: 2 }
    );

    return Option.match(
      Option.flatMap(fetched, ({ body, ms }) =>
        Option.map(Schema.decodeUnknownOption(Descriptor)(body), (d) => ({
          ...d,
          ms,
        }))
      ),
      {
        onNone: () => ({ ...seen, spoke }) satisfies Seen,
        onSome: (d) =>
          ({
            ...seen,
            spoke,
            platform: d.platform?.os ?? null,
            t3: {
              environmentId: d.environmentId,
              label: d.label,
              version: d.serverVersion ?? null,
              url: origin(
                tailscale === null ? address : tailscale.dns || address,
                port
              ),
              latencyMs: d.ms,
            },
          }) satisfies Seen,
      }
    );
  });

const SERVER = new RegExp(LINUX_T3_SERVER, "u");

const t3Binary = (flag: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isSome(flag)) {
      return flag;
    }

    const host = yield* Host;

    if (yield* host.which("t3")) {
      return Option.some("t3");
    }

    const running = (yield* host.processes).find((p) =>
      SERVER.test(p.argv.join(" "))
    );

    return Option.fromUndefinedOr(running?.argv[0]);
  });

const linksOf = (flag: Option.Option<string>) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const bin = yield* t3Binary(flag);

    if (Option.isNone(bin)) {
      return [];
    }

    const ran = yield* host.run([bin.value, "environment", "list", "--json"], {
      timeoutMs: 10_000,
    });

    if (ran.code !== 0) {
      return [];
    }

    const links: readonly T3Link[] = Option.getOrElse(
      Schema.decodeUnknownOption(T3Links)(ran.stdout),
      () => []
    );

    return links;
  });

export interface SnapshotOptions {
  readonly t3: Option.Option<string>;
  readonly t3Port: number;
  readonly spokePort: number;
  /** The fingerprint of the hub's key, which tells which spokes trust this hub. */
  readonly hubKey?: string;
}

export const takeSnapshot = ({
  t3,
  t3Port,
  spokePort,
  hubKey,
}: SnapshotOptions) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const nodes = yield* tailnet;

    const listed: readonly Seen[] = Option.getOrElse(nodes, () => [
      {
        name: host.hostname,
        here: true,
        tailscale: null,
        t3: null,
        platform: null,
        spoke: null,
      },
    ]);

    const [seen, links, virt] = yield* Effect.all(
      [
        Effect.forEach(listed, (node) => probe(node, t3Port, spokePort), {
          concurrency: "unbounded",
        }),
        linksOf(t3),
        Effect.map(
          host.run(["systemd-detect-virt"], { timeoutMs: 3000 }),
          (ran) =>
            ran.code === 0 ? ran.stdout.trim() || BARE_METAL : BARE_METAL
        ),
      ],
      { concurrency: 3 }
    );

    const snapshot: Snapshot = {
      generatedAt: DateTime.formatIso(yield* DateTime.now),
      tailscale: Option.isSome(nodes),
      machines: merge(seen, links, virt, hubKey),
    };

    return snapshot;
  });

export const snapshotFlags = {
  t3: Flag.String("t3").pipe(
    Flag.withDescription(
      "t3 binary that lists this computer's links (default t3 on PATH, then the running T3 server)"
    ),
    Flag.optional
  ),
  t3Port: Flag.Int("t3-port").pipe(
    Flag.withDescription("port T3 Code answers on (default 3773)"),
    Flag.withSchema(Port),
    Flag.withDefault(3773)
  ),
  spokePort: Flag.Int("spoke-port").pipe(
    Flag.withDescription(
      `port each machine's devbox spoke answers on (default ${SPOKE_PORT})`
    ),
    Flag.withSchema(Port),
    Flag.withDefault(SPOKE_PORT)
  ),
};

const TONE: Record<MachineState, Tone> = {
  t3: "green",
  online: "cyan",
  offline: "gray",
};

const NONE = { text: "-", tone: "dim" } as const;

const COLUMNS: readonly Column<Machine>[] = [
  {
    header: "machine",
    cell: (m) => (m.here ? [m.name, { text: " (here)", tone: "dim" }] : m.name),
  },
  { header: "kind", cell: (m) => m.kind },
  { header: "state", cell: (m) => ({ text: m.state, tone: TONE[m.state] }) },
  {
    header: "where",
    cell: (m) => {
      if (m.tailscale !== null) {
        return [
          m.tailscale.dns || m.tailscale.ip,
          { text: ` ${m.tailscale.ip}`, tone: "dim" },
        ];
      }

      return m.t3?.link?.urls[0] ?? NONE;
    },
  },
  {
    header: "T3 Code",
    cell: (m) =>
      m.t3 === null || m.t3.latencyMs === null
        ? NONE
        : [m.t3.version ?? "?", { text: ` ${m.t3.latencyMs}ms`, tone: "dim" }],
  },
  {
    header: "agent link",
    cell: (m) =>
      m.t3?.link ? `${m.t3.link.status}, ${m.t3.link.access}` : NONE,
  },
];

export const machines = Command.make(
  "machines",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("print the snapshot as JSON on stdout"),
      Flag.withDefault(false)
    ),
    ...snapshotFlags,
  },
  ({ json, t3, t3Port, spokePort }) =>
    Effect.gen(function* () {
      const out = yield* Output;
      const snapshot = yield* takeSnapshot({ t3, t3Port, spokePort });

      if (json) {
        return yield* out.json(snapshot);
      }

      if (!snapshot.tailscale) {
        yield* out.note(
          "Tailscale did not answer, so this lists only this machine and its links"
        );
      }

      yield* out.table(COLUMNS, snapshot.machines);
    })
).pipe(
  Command.withDescription(
    "List your machines: where each is on Tailscale, whether it runs T3 Code, and how agents here reach it"
  )
);
