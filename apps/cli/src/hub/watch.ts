import type { MachineState, Snapshot } from "./machines.ts";

/** What has been said about each machine, and what has been seen since but not yet said. */
export interface Watch {
  readonly announced: Readonly<Record<string, MachineState>>;
  readonly pending: Readonly<
    Record<string, { readonly state: MachineState; readonly samples: number }>
  >;
}

export interface Notice {
  readonly machine: string;
  readonly from: MachineState;
  readonly to: MachineState;
  readonly at: string;
}

// One missed probe is not news.
const HOLD_SAMPLES = 2;

/**
 * A change of state is announced once it has held for two samples in a row. The first sample of a
 * machine sets its baseline and says nothing. A machine missing from a sample keeps what was last
 * said about it.
 */
export const nextWatch = (
  previous: Watch | undefined,
  snapshot: Snapshot
): { readonly watch: Watch; readonly notices: readonly Notice[] } => {
  const announced: Record<string, MachineState> = { ...previous?.announced };
  const pending: Record<string, { state: MachineState; samples: number }> = {};
  const notices: Notice[] = [];

  for (const { name, state } of snapshot.machines) {
    const said = announced[name];

    if (said === undefined) {
      announced[name] = state;
    }

    if (said === undefined || said === state) {
      continue;
    }

    const before = previous?.pending[name];
    const samples = before?.state === state ? before.samples + 1 : 1;

    if (samples < HOLD_SAMPLES) {
      pending[name] = { state, samples };
      continue;
    }

    announced[name] = state;
    notices.push({
      machine: name,
      from: said,
      to: state,
      at: snapshot.generatedAt,
    });
  }

  return { watch: { announced, pending }, notices };
};

const SENTENCES: Readonly<Record<string, (machine: string) => string>> = {
  "t3>offline": (m) => `${m} went offline`,
  "online>offline": (m) => `${m} went offline`,
  "offline>online": (m) => `${m} is back online`,
  "offline>t3": (m) => `${m} is back online, and T3 Code answers`,
  "t3>online": (m) => `T3 Code stopped answering on ${m}`,
  "online>t3": (m) => `T3 Code answers on ${m} again`,
};

export const sentence = ({ machine, from, to }: Notice): string =>
  SENTENCES[`${from}>${to}`]?.(machine) ?? `${machine} is now ${to}`;

// The services that want JSON, by host, and the field their message goes in.
const JSON_FIELD: Readonly<Record<string, string>> = {
  "discord.com": "content",
  "discordapp.com": "content",
  "hooks.slack.com": "text",
};

export interface WebhookBody {
  readonly body: string;
  readonly contentType: string;
}

/** Discord and Slack take JSON. Anything else, such as an ntfy topic, takes the sentence itself. */
export const webhookBody = (url: URL, text: string): WebhookBody => {
  const field = JSON_FIELD[url.hostname];

  return field === undefined
    ? { body: text, contentType: "text/plain; charset=utf-8" }
    : {
        body: JSON.stringify({ [field]: text }),
        contentType: "application/json",
      };
};
