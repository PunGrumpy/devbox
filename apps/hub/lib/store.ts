import { requestLogout } from "@/lib/auth";
import type { FetchLike } from "@/lib/auth";
import { snapshotSchema } from "@/lib/machines";
import type { Snapshot } from "@/lib/machines";

export type HubStatus =
  | "loading"
  | "not-answering"
  | "signed-in"
  | "signed-out";

export interface HubState {
  readonly snapshot: Snapshot | null;
  readonly status: HubStatus;
}

const HTTP_UNAUTHORIZED = 401;
const POLL_MS = 15_000;
const TICK_MS = 1000;

type FetchResult =
  | { readonly kind: "failed" }
  | { readonly kind: "ok"; readonly snapshot: Snapshot }
  | { readonly kind: "unauthorized" };

const fetchSnapshot = async (request: FetchLike) => {
  const response = await request("/api/machines", { cache: "no-store" });

  if (response.status === HTTP_UNAUTHORIZED) {
    return { kind: "unauthorized" } satisfies FetchResult;
  }

  if (!response.ok) {
    return { kind: "failed" } satisfies FetchResult;
  }

  const parsed = snapshotSchema.safeParse(await response.json());

  return parsed.success
    ? ({ kind: "ok", snapshot: parsed.data } satisfies FetchResult)
    : ({ kind: "failed" } satisfies FetchResult);
};

export const createHubStore = (request: FetchLike = fetch) => {
  const listeners = new Set<() => void>();
  let state: HubState = { snapshot: null, status: "loading" };
  let now = 0;
  let generation = 0;
  let poll: ReturnType<typeof setInterval> | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const markSignedOut = () => {
    generation += 1;
    state = { snapshot: null, status: "signed-out" };
    now = Date.now();
    emit();
  };

  const refresh = async () => {
    const turn = generation;

    const result = await fetchSnapshot(request).catch(
      () => ({ kind: "failed" }) satisfies FetchResult
    );

    if (turn !== generation) {
      return state;
    }

    if (result.kind === "unauthorized") {
      state = { snapshot: null, status: "signed-out" };
    } else if (result.kind === "ok") {
      state = { snapshot: result.snapshot, status: "signed-in" };
    } else {
      state = { snapshot: state.snapshot, status: "not-answering" };
    }

    now = Date.now();
    emit();

    return state;
  };

  const signOut = async () => {
    generation += 1;
    await requestLogout(request);
    state = { snapshot: null, status: "signed-out" };
    now = Date.now();
    emit();
  };

  const refreshWhenVisible = () => {
    if (!document.hidden && state.status !== "signed-out") {
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

  const subscribe = (listener: () => void) => {
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

  const getHubState = () => state;
  const getNow = () => now;

  return {
    getHubState,
    getNow,
    markSignedOut,
    refresh,
    signOut,
    subscribe,
  };
};

const defaultStore = createHubStore();

export const { refresh } = defaultStore;

export const { markSignedOut } = defaultStore;

export const { signOut } = defaultStore;

export const { subscribe } = defaultStore;

export const { getHubState } = defaultStore;

export const { getNow } = defaultStore;

const SERVER_STATE: HubState = { snapshot: null, status: "loading" };

export const getServerHubState = () => SERVER_STATE;

export const getServerNow = () => 0;
