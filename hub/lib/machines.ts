import { z } from "zod";

const tailnetSchema = z.object({
  dns: z.string(),
  ip: z.string(),
  lastSeen: z.string().nullable(),
  online: z.boolean(),
  os: z.string(),
});

const linkSchema = z.object({
  access: z.string(),
  expiresAt: z.string(),
  status: z.string(),
  urls: z.array(z.string()),
});

const t3Schema = z.object({
  environmentId: z.string(),
  label: z.string(),
  latencyMs: z.number().nullable(),
  link: linkSchema.nullable(),
  url: z.string().nullable(),
  version: z.string().nullable(),
});

const machineSchema = z.object({
  here: z.boolean(),
  name: z.string(),
  state: z.enum(["t3", "online", "offline"]),
  t3: t3Schema.nullable(),
  tailscale: tailnetSchema.nullable(),
});

export const snapshotSchema = z.object({
  generatedAt: z.string(),
  history: z.object({
    sampleSeconds: z.number().positive(),
    startedAt: z.string(),
    states: z.record(z.string(), z.string()),
  }),
  machines: z.array(machineSchema),
  tailscale: z.boolean(),
});

export type Machine = z.infer<typeof machineSchema>;

export type MachineState = Machine["state"];

export type Link = z.infer<typeof linkSchema>;

export type Snapshot = z.infer<typeof snapshotSchema>;

export type BarState = MachineState | "unknown";

const SECOND = 1000;
const MINUTE = 60;
const HOUR = 60;
const TWO_DAYS_IN_HOURS = 48;
const DAY = 24;

/** A length of time as one short unit: 42s, 5m, 3h, 12d. */
export const span = (milliseconds: number) => {
  const seconds = Math.max(0, Math.round(milliseconds / SECOND));

  if (seconds < MINUTE) {
    return `${seconds}s`;
  }

  const minutes = Math.round(seconds / MINUTE);

  if (minutes < HOUR) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / HOUR);

  if (hours < TWO_DAYS_IN_HOURS) {
    return `${hours}h`;
  }

  return `${Math.round(hours / DAY)}d`;
};

export const ago = (iso: string, now: number) =>
  `${span(now - Date.parse(iso))} ago`;

export const BAR_COUNT = 48;
const BAR_SECONDS = 1800;

const worstState = (samples: string) => {
  if (samples.includes("0")) {
    return "offline";
  }

  if (samples.includes("1")) {
    return "online";
  }

  return samples.includes("2") ? "t3" : "unknown";
};

/**
 * The hub writes one character per sample, newest last. Each bar shows the worst state in its
 * 30 minutes, so a short outage stays visible.
 */
export const bars = (states: string, sampleSeconds: number) => {
  const perBar = Math.max(1, Math.round(BAR_SECONDS / sampleSeconds));

  return Array.from({ length: BAR_COUNT }, (_, bar) => {
    const end = states.length - (BAR_COUNT - 1 - bar) * perBar;

    return worstState(
      states.slice(Math.max(0, end - perBar), Math.max(0, end))
    ) satisfies BarState;
  });
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The second line of the "where" cell: the Tailscale IP, or the host of the link's URL. */
export const whereDetail = (machine: Machine) => {
  if (machine.tailscale) {
    return machine.tailscale.ip;
  }

  const [url] = machine.t3?.link?.urls ?? [];

  return url === undefined ? "" : hostOf(url);
};

export const linkText = (link: Link | null | undefined) => {
  if (!link) {
    return "Not linked";
  }

  return link.status === "reachable" ? "Linked" : `Linked, ${link.status}`;
};

export const stateText = (machine: Machine, now: number) => {
  const latency = machine.t3?.latencyMs;

  if (machine.state === "t3" && latency !== null && latency !== undefined) {
    return `T3 Code ready · ${Math.round(latency)} ms`;
  }

  const lastSeen = machine.tailscale?.lastSeen ?? null;

  if (machine.state === "offline" && lastSeen !== null) {
    return `Offline · seen ${ago(lastSeen, now)}`;
  }

  const text = {
    offline: "Offline",
    online: "Online",
    t3: "T3 Code ready",
  } satisfies Record<MachineState, string>;

  return text[machine.state];
};

export const FILTERS = [
  { key: "all", label: "All", test: () => true },
  { key: "t3", label: "T3 Code", test: (m: Machine) => m.state === "t3" },
  {
    key: "online",
    label: "Online",
    test: (m: Machine) => m.state !== "offline",
  },
  {
    key: "offline",
    label: "Offline",
    test: (m: Machine) => m.state === "offline",
  },
] as const;

export type FilterKey = (typeof FILTERS)[number]["key"];

export const summarize = (machines: readonly Machine[]) => {
  const ready = machines.filter((m) => m.state === "t3");

  const linked = machines.flatMap((m) =>
    m.t3?.link
      ? [{ expiresAt: Date.parse(m.t3.link.expiresAt), name: m.name }]
      : []
  );

  const answered = ready.flatMap((m) =>
    m.t3 && m.t3.latencyMs !== null
      ? [{ latencyMs: m.t3.latencyMs, name: m.name }]
      : []
  );

  return {
    linked: linked.length,
    nextExpiry: linked.toSorted((a, b) => a.expiresAt - b.expiresAt)[0],
    online: machines.filter((m) => m.state !== "offline").length,
    ready: ready.length,
    slowest: answered.toSorted((a, b) => b.latencyMs - a.latencyMs)[0],
    total: machines.length,
  };
};
