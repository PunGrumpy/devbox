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

export const summarize = (machines: readonly Machine[]) => ({
  linked: machines.filter((m) => m.t3?.link).length,
  ready: machines.filter((m) => m.state === "t3").length,
});

export const STATE_LABEL = {
  offline: "Offline",
  online: "Online",
  t3: "T3 Code ready",
} satisfies Record<MachineState, string>;

const t3Sentence = (machine: Machine, now: number) => {
  const { state, t3, tailscale } = machine;

  if (state === "t3" && t3 !== null && t3.latencyMs !== null) {
    const version = t3.version === null ? "" : ` ${t3.version}`;

    return `T3 Code${version} answered in ${Math.round(t3.latencyMs)} ms.`;
  }

  if (state === "t3") {
    return "T3 Code answers through its link.";
  }

  if (state === "online") {
    return "On the tailnet, with no T3 Code found.";
  }

  const lastSeen = tailscale?.lastSeen ?? null;

  return lastSeen === null
    ? "Not answering."
    : `Last seen ${ago(lastSeen, now)}.`;
};

const linkSentence = (link: Link | null, now: number) => {
  if (link === null) {
    return "Not linked for agents.";
  }

  const left = `${span(Date.parse(link.expiresAt) - now)} left`;

  return link.status === "reachable"
    ? `Linked for agents with ${link.access}, ${left}.`
    : `Linked for agents but ${link.status}, ${left}.`;
};

/** What a person would say about a machine, in two short sentences. */
export const describe = (machine: Machine, now: number) =>
  `${t3Sentence(machine, now)} ${linkSentence(machine.t3?.link ?? null, now)}`;

/** The page's opening line, split where its last words take the gradient. */
export const headline = (
  machines: readonly Machine[] | null,
  failing: boolean
) => {
  if (machines === null) {
    return failing
      ? { accent: "not answering.", lead: "The hub is" }
      : { accent: "its machines.", lead: "Asking the hub for" };
  }

  if (machines.length === 0) {
    return { accent: "no machines.", lead: "The hub knows" };
  }

  const online = machines.filter((m) => m.state !== "offline").length;
  const noun = machines.length === 1 ? "machine is" : "machines are";

  if (online === machines.length) {
    return { accent: "online.", lead: `All ${machines.length} ${noun}` };
  }

  return { accent: "online.", lead: `${online} of ${machines.length} ${noun}` };
};
