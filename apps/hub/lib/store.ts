import { snapshotSchema } from "@/lib/machines";
import type { Snapshot } from "@/lib/machines";

interface HubState {
  failing: boolean;
  snapshot: Snapshot | null;
}

const POLL_MS = 15_000;
const TICK_MS = 1000;

const listeners = new Set<() => void>();
let state: HubState = { failing: false, snapshot: null };
let now = 0;
let poll: ReturnType<typeof setInterval> | undefined;
let clock: ReturnType<typeof setInterval> | undefined;

const emit = () => {
  for (const listener of listeners) {
    listener();
  }
};

const fetchSnapshot = async () => {
  const response = await fetch("/api/machines", { cache: "no-store" });

  if (!response.ok) {
    return null;
  }

  const parsed = snapshotSchema.safeParse(await response.json());

  return parsed.success ? parsed.data : null;
};

/** Asks the hub for its latest snapshot. A failure keeps the snapshot already shown. */
export const refresh = async () => {
  const snapshot = await fetchSnapshot().catch(() => null);
  state =
    snapshot === null
      ? { ...state, failing: true }
      : { failing: false, snapshot };
  now = Date.now();
  emit();
};

const refreshWhenVisible = () => {
  if (!document.hidden) {
    void refresh();
  }
};

const start = () => {
  now = Date.now();
  void refresh();
  poll = setInterval(refreshWhenVisible, POLL_MS);
  clock = setInterval(() => {
    now = Date.now();
    emit();
  }, TICK_MS);
  document.addEventListener("visibilitychange", refreshWhenVisible);
};

const stop = () => {
  clearInterval(poll);
  clearInterval(clock);
  document.removeEventListener("visibilitychange", refreshWhenVisible);
};

export const subscribe = (listener: () => void) => {
  listeners.add(listener);

  if (listeners.size === 1) {
    start();
  }

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0) {
      stop();
    }
  };
};

export const getHubState = () => state;

/** The time of the last tick, so every "ago" label on the page moves together. */
export const getNow = () => now;

const SERVER_STATE: HubState = { failing: false, snapshot: null };

export const getServerHubState = () => SERVER_STATE;

export const getServerNow = () => 0;
