import { z } from "zod";

import type { FetchLike } from "@/lib/auth";
import type { Cloudflare, Machine } from "@/lib/machines";

const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;

const MINUTES_VALID = 15;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

/** How long a pairing link stays valid before the page drops it from state. */
export const PAIR_TTL_MS = MINUTES_VALID * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** The four machine actions that share the ask, confirm, send and report lifecycle. */
export type MachineAction = "pair" | "publish" | "unpublish" | "update";

export interface ActionReply {
  readonly error?: string | null;
  readonly step?: string | null;
  readonly url?: string | null;
}

export interface ActionOutcome {
  readonly message: string;
  readonly ok: boolean;
  readonly signedOut: boolean;
  readonly url: string | null;
}

export type MachineActionState =
  | { readonly action: MachineAction; readonly phase: "confirming" }
  | { readonly action: MachineAction; readonly phase: "sending" }
  | {
      readonly action: MachineAction;
      readonly message: string;
      readonly ok: boolean;
      readonly phase: "done";
      readonly url: string | null;
    };

const replyBodySchema = z.object({
  error: z.string().optional(),
  step: z.string().optional(),
  url: z.string().optional(),
});

const safeLink = (value: string | null | undefined) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  try {
    const parsed = new URL(value);

    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? value
      : null;
  } catch {
    return null;
  }
};

const SENTENCE_END = /[.!?]$/u;
const SENTENCE_START = /^[A-Z]/u;

const trimStop = (text: string) => {
  const trimmed = text.trim();
  let end = trimmed.length;

  while (end > 0 && trimmed[end - 1] === ".") {
    end -= 1;
  }

  return trimmed.slice(0, end);
};

const stepFailure = (
  verb: string,
  name: string,
  reply: ActionReply,
  fallback: string
) => {
  const step = reply.step?.trim() ?? "";

  if (step !== "") {
    return `${verb} ${name} failed at ${trimStop(step)}.`;
  }

  const error = reply.error?.trim() ?? "";

  if (error === "") {
    return fallback;
  }

  if (SENTENCE_START.test(error) && error.includes(" ")) {
    return SENTENCE_END.test(error) ? error : `${error}.`;
  }

  return `${verb} ${name} failed at ${trimStop(error)}.`;
};

const ok = (message: string, url: string | null = null) =>
  ({
    message,
    url,
    ok: true,
    signedOut: false,
  }) satisfies ActionOutcome;

const fail = (message: string, signedOut = false) =>
  ({
    message,
    signedOut,
    ok: false,
    url: null,
  }) satisfies ActionOutcome;

type ReplyHandler = (name: string, reply: ActionReply) => ActionOutcome;

interface ActionSpec {
  readonly busyLabel: string;
  readonly confirm: ((name: string, zone: string | null) => string) | null;
  readonly label: string;
  readonly method: "DELETE" | "POST";
  readonly path: (name: string) => string;
  readonly replies: ReadonlyMap<number, ReplyHandler>;
  readonly sending: (name: string) => string;
  readonly ttlMs: number | null;
}

/** The hostname a machine takes when published under a Cloudflare zone. */
export const tunnelHostname = (name: string, zone: string) =>
  `t3-${name.toLowerCase().replaceAll(/[^a-z0-9]/gu, "-")}.${zone}`;

/** Whether a machine runs a known T3 Code version that differs from the latest one. */
export const needsUpdate = (machine: Machine, latest: string | null) => {
  const version = machine.t3?.version ?? null;

  return latest !== null && version !== null && version !== latest;
};

/** The command to run on a machine so its spoke trusts this hub. */
export const trustCommand = (key: string) => `devbox up --spoke --trust ${key}`;

/** Whether a machine can hand out a pairing link through this hub. */
export const canPair = (machine: Machine) =>
  machine.spoke === "trusted" && machine.state === "t3";

/** Whether a machine can be published through Cloudflare from this hub. */
export const canPublish = (machine: Machine, cloudflare: Cloudflare | null) =>
  cloudflare !== null && machine.spoke === "trusted" && machine.tunnel === null;

/** Whether a machine has a tunnel that can be removed through this hub. */
export const canUnpublish = (machine: Machine, cloudflare: Cloudflare | null) =>
  cloudflare !== null && machine.spoke === "trusted" && machine.tunnel !== null;

/** The quiet actions currently available on a machine card, in display order. */
export const eligibleActions = (
  machine: Machine,
  latest: string | null,
  cloudflare: Cloudflare | null
) => {
  const list: MachineAction[] = [];

  if (needsUpdate(machine, latest) && machine.spoke === "trusted") {
    list.push("update");
  }

  if (canPair(machine)) {
    list.push("pair");
  }

  if (canPublish(machine, cloudflare)) {
    list.push("publish");
  } else if (canUnpublish(machine, cloudflare)) {
    list.push("unpublish");
  }

  return list;
};

const updateAccepted: ReplyHandler = (name) =>
  ok(`Asked ${name} to update. Its version changes here within a few minutes.`);

const SHARED_REPLIES = new Map<number, ReplyHandler>([
  [HTTP_NOT_FOUND, (name) => fail(`The hub no longer lists ${name}.`)],
  [HTTP_UNAUTHORIZED, () => fail("Your session ended. Sign in again.", true)],
]);

/** The single table describing every machine action: route, copy, confirmation, and replies. */
export const MACHINE_ACTIONS = {
  pair: {
    busyLabel: "Pairing…",
    confirm: null,
    label: "Pair this device",
    method: "POST",
    path: (name) => `/api/machines/${encodeURIComponent(name)}/pair`,
    replies: new Map<number, ReplyHandler>([
      [
        HTTP_BAD_GATEWAY,
        (name) =>
          fail(`${name} refused the pairing request or did not answer.`),
      ],
      [
        HTTP_CONFLICT,
        (name) => fail(`${name} does not trust this hub for pairing.`),
      ],
      [HTTP_FORBIDDEN, () => fail("The hub refused the pairing request.")],
      [
        HTTP_OK,
        (_name, reply) => {
          const valid = safeLink(reply.url);

          return valid === null
            ? fail("The hub answered without a pairing link.")
            : ok("Pairing link, good for 15 minutes.", valid);
        },
      ],
    ]),
    sending: (name) => `Asking ${name} for a pairing link…`,
    ttlMs: PAIR_TTL_MS,
  },
  publish: {
    busyLabel: "Publishing…",
    confirm: (name, zone) =>
      `This puts T3 Code on ${name} on the internet at ${tunnelHostname(name, zone ?? "")}. Its sign-in page becomes public.`,
    label: "Publish",
    method: "POST",
    path: (name) => `/api/machines/${encodeURIComponent(name)}/tunnel`,
    replies: new Map<number, ReplyHandler>([
      [
        HTTP_ACCEPTED,
        (name, reply) => {
          const valid = safeLink(reply.url);

          return ok(
            valid === null
              ? `Asked ${name} to go public. It can take a minute.`
              : `Asked ${name} to go public at ${valid}. It can take a minute.`
          );
        },
      ],
      [
        HTTP_BAD_GATEWAY,
        (name, reply) =>
          fail(
            stepFailure(
              "Publishing",
              name,
              reply,
              `Could not publish ${name}. Cloudflare or the machine did not answer.`
            )
          ),
      ],
      [
        HTTP_CONFLICT,
        (name) => fail(`${name} is not ready to be published from this hub.`),
      ],
      [HTTP_FORBIDDEN, () => fail("The hub refused the publish request.")],
    ]),
    sending: (name) => `Asking ${name} to go public…`,
    ttlMs: null,
  },
  unpublish: {
    busyLabel: "Unpublishing…",
    confirm: (name) =>
      `This takes ${name} off the internet. Devices paired through that address stop working.`,
    label: "Unpublish",
    method: "DELETE",
    path: (name) => `/api/machines/${encodeURIComponent(name)}/tunnel`,
    replies: new Map<number, ReplyHandler>([
      [
        HTTP_BAD_GATEWAY,
        (name, reply) =>
          fail(
            stepFailure(
              "Unpublishing",
              name,
              reply,
              `Could not unpublish ${name}. Cloudflare or the machine did not answer.`
            )
          ),
      ],
      [
        HTTP_CONFLICT,
        (name) => fail(`${name} is not ready to be unpublished from this hub.`),
      ],
      [HTTP_FORBIDDEN, () => fail("The hub refused the unpublish request.")],
      [HTTP_NO_CONTENT, (name) => ok(`Asked ${name} to leave the internet.`)],
    ]),
    sending: (name) => `Asking ${name} to leave the internet…`,
    ttlMs: null,
  },
  update: {
    busyLabel: "Updating…",
    confirm: (name) =>
      `This restarts T3 Code on ${name} and stops the agents running there.`,
    label: "Update",
    method: "POST",
    path: (name) => `/api/machines/${encodeURIComponent(name)}/update`,
    replies: new Map<number, ReplyHandler>([
      [HTTP_ACCEPTED, updateAccepted],
      [
        HTTP_BAD_GATEWAY,
        (name) => fail(`${name} refused the update or did not answer.`),
      ],
      [
        HTTP_CONFLICT,
        (name) => fail(`${name} is not ready to take an update from this hub.`),
      ],
      [HTTP_FORBIDDEN, () => fail("The hub refused the update request.")],
      [HTTP_OK, updateAccepted],
    ]),
    sending: (name) => `Asking ${name} to update…`,
    ttlMs: null,
  },
} satisfies Record<MachineAction, ActionSpec>;

/** Turns a hub reply status (or null on a network failure) for any machine action into an outcome. */
export const describeActionReply = (
  action: MachineAction,
  name: string,
  status: number | null,
  reply: ActionReply = {}
) => {
  if (status === null) {
    return fail("The hub is not answering.");
  }

  const handler =
    MACHINE_ACTIONS[action].replies.get(status) ?? SHARED_REPLIES.get(status);

  if (handler !== undefined) {
    return handler(name, reply);
  }

  return fail(`The hub answered with status ${status}.`);
};

/** Sends a machine action request to the hub using the session cookie. */
export const requestAction = async (
  action: MachineAction,
  name: string,
  request: FetchLike = fetch
) => {
  const spec = MACHINE_ACTIONS[action];

  try {
    const response = await request(spec.path(name), {
      cache: "no-store",
      method: spec.method,
    });

    if (response.status === HTTP_NO_CONTENT) {
      return describeActionReply(action, name, response.status);
    }

    const parsed = replyBodySchema.safeParse(
      await response.json().catch(() => null)
    );

    return describeActionReply(
      action,
      name,
      response.status,
      parsed.success ? parsed.data : {}
    );
  } catch {
    return describeActionReply(action, name, null);
  }
};
