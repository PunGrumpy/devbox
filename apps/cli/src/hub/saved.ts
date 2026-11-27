import { Option, Schema } from "effect";

import type { History } from "./hub.ts";
import type { Watch } from "./watch.ts";

const State = Schema.Literals(["t3", "online", "offline"]);

const Saved = Schema.fromJsonString(
  Schema.Struct({
    savedAt: Schema.String,
    history: Schema.Struct({
      sampleSeconds: Schema.Number,
      startedAt: Schema.String,
      states: Schema.Record(Schema.String, Schema.String),
      latency: Schema.optional(
        Schema.Record(Schema.String, Schema.Array(Schema.NullOr(Schema.Number)))
      ),
    }),
    watch: Schema.Struct({
      announced: Schema.Record(Schema.String, State),
      pending: Schema.Record(
        Schema.String,
        Schema.Struct({ state: State, samples: Schema.Number })
      ),
    }),
  })
);

export type Resumed = { readonly history: History; readonly watch: Watch };

export const serialize = (resumed: Resumed, savedAt: string): string =>
  `${JSON.stringify({ savedAt, ...resumed })}\n`;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a hub that starts again takes over from the one before. A file that does not parse, or one
 * older than the history's own 24 hours, gives nothing. The time the hub was down becomes unknown
 * samples, so the bars before it do not slide into the present.
 */
export const restore = (
  text: string,
  now: number,
  limit: number
): Option.Option<Resumed> =>
  Option.flatMap(
    Schema.decodeUnknownOption(Saved)(text),
    ({ savedAt, history, watch }) => {
      const away = now - Date.parse(savedAt);

      if (!(away >= 0 && away < DAY_MS && history.sampleSeconds > 0)) {
        return Option.none();
      }

      const missed = Math.min(
        limit,
        Math.floor(away / (history.sampleSeconds * 1000))
      );

      const gap = " ".repeat(missed);

      const states = Object.fromEntries(
        Object.entries(history.states)
          .map(
            ([name, samples]) =>
              [name, `${samples}${gap}`.slice(-limit)] as const
          )
          .filter(([, samples]) => samples.trim() !== "")
      );

      const nullGap: readonly null[] = Array<null>(missed).fill(null);

      const latency = Object.fromEntries(
        Object.entries(history.latency ?? {})
          .filter(([name]) => Object.hasOwn(states, name))
          .map(
            ([name, samples]) =>
              [name, [...samples, ...nullGap].slice(-limit)] as const
          )
      );

      return Option.some({
        history: {
          sampleSeconds: history.sampleSeconds,
          startedAt: history.startedAt,
          states,
          latency,
        },
        watch,
      });
    }
  );
