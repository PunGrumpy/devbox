import { styleText } from "node:util";

import { BunServices } from "@effect/platform-bun";
import { Context, Duration, Effect, Layer, Predicate } from "effect";
import { Prompt } from "effect/cli";

import { Aborted, NotATerminal } from "./errors.ts";

export type Tone =
  | "dim"
  | "bold"
  | "cyan"
  | "green"
  | "yellow"
  | "red"
  | "gray";

export type Cell =
  | string
  | { readonly text: string; readonly tone: Tone }
  | readonly Cell[];

export interface Column<Row> {
  readonly header: string;
  readonly cell: (row: Row) => Cell;
  readonly align?: "left" | "right";
}

export type Paint = (tone: Tone, text: string) => string;

export interface Streams {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly paint: Paint;
  readonly stdoutColor: boolean;
  readonly interactive: boolean;
  readonly readAnswer: Effect.Effect<string>;
  /** Shows a multi-select and returns the indices ticked. Only called when `interactive`. */
  readonly pickMany: (
    question: string,
    choices: readonly {
      readonly title: string;
      readonly selected: boolean;
    }[]
  ) => Effect.Effect<readonly number[], Aborted>;
}

export class Output extends Context.Service<
  Output,
  {
    readonly paint: Paint;
    readonly stdoutColor: boolean;
    readonly stdout: (text: string) => Effect.Effect<void>;
    readonly line: (text?: string) => Effect.Effect<void>;
    readonly log: (message: string) => Effect.Effect<void>;
    readonly success: (
      message: string,
      elapsed?: Duration.Duration
    ) => Effect.Effect<void>;
    readonly note: (message: string) => Effect.Effect<void>;
    readonly warn: (message: string) => Effect.Effect<void>;
    readonly error: (message: string, hint?: string) => Effect.Effect<void>;
    readonly check: (
      ok: boolean,
      label: Cell,
      detail?: string
    ) => Effect.Effect<void>;
    readonly table: <Row>(
      columns: readonly Column<Row>[],
      rows: readonly Row[]
    ) => Effect.Effect<void>;
    readonly pairs: (
      pairs: readonly (readonly [string, string])[]
    ) => Effect.Effect<void>;
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- prints any value JSON can hold
    readonly json: (value: unknown) => Effect.Effect<void>;
    readonly step: <A, E, R>(
      message: string,
      task: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, R>;
    readonly confirm: (
      question: string
    ) => Effect.Effect<boolean, NotATerminal>;
    readonly pick: <A>(
      question: string,
      choices: readonly {
        readonly title: string;
        readonly value: A;
        readonly selected: boolean;
      }[]
    ) => Effect.Effect<readonly A[], NotATerminal | Aborted>;
  }
>()("devbox/Output") {
  static readonly make = (streams: Streams) => {
    const { paint } = streams;

    const show: (cell: Cell, toned: Paint) => string = (cell, toned) => {
      if (Predicate.isString(cell)) {
        return cell;
      }

      if ("tone" in cell) {
        return toned(cell.tone, cell.text);
      }

      return cell.map((inner) => show(inner, toned)).join("");
    };

    const text = (cell: Cell) => show(cell, (_, value) => value);

    const render = (cell: Cell) => show(cell, paint);

    const line = (value = "") =>
      Effect.sync(() => {
        streams.stderr(`${value}\n`);
      });

    const timing = (elapsed: Duration.Duration) =>
      paint("dim", `[${formatElapsed(elapsed)}]`);

    const log = (message: string) => line(`${paint("dim", ">")} ${message}`);

    const pad = (cell: Cell, width: number, align: "left" | "right") => {
      const fill = " ".repeat(Math.max(0, width - text(cell).length));

      return align === "right"
        ? `${fill}${render(cell)}`
        : `${render(cell)}${fill}`;
    };

    return {
      paint,
      line,
      log,
      stdoutColor: streams.stdoutColor,
      stdout: (value) =>
        Effect.sync(() => {
          streams.stdout(value);
        }),
      success: (message, elapsed) => {
        const suffix = elapsed === undefined ? "" : ` ${timing(elapsed)}`;

        return line(`${paint("cyan", "> Success!")} ${message}${suffix}`);
      },
      note: (message) =>
        line(`${paint("bold", paint("yellow", "> NOTE:"))} ${message}`),
      warn: (message) =>
        line(`${paint("bold", paint("yellow", "> WARN!"))} ${message}`),
      error: (message, hint) =>
        Effect.andThen(
          line(`${paint("bold", paint("red", "Error:"))} ${message}`),
          hint === undefined ? Effect.void : log(hint)
        ),
      check: (ok, label, detail) => {
        const suffix =
          detail === undefined || detail === ""
            ? ""
            : `  ${paint("dim", detail)}`;

        return line(
          `${ok ? paint("green", "✔") : paint("red", "✖")} ${render(label)}${suffix}`
        );
      },
      table: (columns, rows) =>
        Effect.gen(function* () {
          const header = columns.map(
            (column) => ({ text: column.header, tone: "dim" }) satisfies Cell
          );

          const body = rows.map((row) =>
            columns.map((column) => column.cell(row))
          );

          const widths = columns.map((_, i) =>
            Math.max(
              ...[header, ...body].map((cells) => text(cells[i] ?? "").length)
            )
          );

          for (const cells of [header, ...body]) {
            yield* line(
              `  ${cells.map((cell, i) => pad(cell, widths[i] ?? 0, columns[i]?.align ?? "left")).join("  ")}`
            );
          }
        }),
      pairs: (pairs) =>
        Effect.forEach(
          pairs,
          ([key, value]) =>
            line(
              `  ${paint("dim", key.padEnd(Math.max(...pairs.map(([k]) => k.length))))}  ${value}`
            ),
          { discard: true }
        ),
      json: (value) =>
        Effect.sync(() => {
          streams.stdout(`${JSON.stringify(value, null, 2)}\n`);
        }),
      step: (message, task) =>
        Effect.gen(function* () {
          if (streams.interactive) {
            yield* Effect.sync(() => {
              streams.stderr(`${paint("dim", ">")} ${message} …`);
            });
          }

          const [elapsed, result] = yield* Effect.timed(task);

          if (streams.interactive) {
            yield* Effect.sync(() => {
              streams.stderr("\r\u001B[2K");
            });
          }

          yield* log(`${message} ${timing(elapsed)}`);

          return result;
        }),
      confirm: (question) =>
        Effect.gen(function* () {
          if (!streams.interactive) {
            return yield* new NotATerminal();
          }

          yield* Effect.sync(() => {
            streams.stderr(
              `${paint("cyan", "?")} ${question} ${paint("dim", "(y/N)")} `
            );
          });
          const yes = /^\s*y(?:es)?\s*$/iu.test(yield* streams.readAnswer);
          yield* line(paint("dim", yes ? "yes" : "no"));

          return yes;
        }),
      pick: (question, choices) =>
        Effect.gen(function* () {
          if (!streams.interactive) {
            return yield* new NotATerminal();
          }

          const indices = yield* streams.pickMany(question, choices);

          return indices.flatMap((i) =>
            choices[i] === undefined ? [] : [choices[i].value]
          );
        }),
    } satisfies Output["Service"];
  };

  /** Writes to stderr with `process.stderr.write`, because Bun's `console.error` paints the whole line red on a terminal. */
  static readonly layer = Layer.sync(Output, () =>
    Output.make({
      stdout: (value) => {
        process.stdout.write(value);
      },
      stderr: (value) => {
        process.stderr.write(value);
      },
      paint: colorFor(process.stderr),
      stdoutColor: colorFor(process.stdout)("bold", "x") !== "x",
      interactive: process.stdin.isTTY && process.stderr.isTTY,
      readAnswer: Effect.callback<string>((resume) => {
        process.stdin.resume();
        process.stdin.once("data", (chunk: Buffer | string) => {
          process.stdin.pause();
          resume(Effect.succeed(chunk.toString()));
        });
      }),
      pickMany: (question, choices) =>
        Prompt.run(
          Prompt.MultiSelect({
            message: question,
            choices: choices.map((choice, i) => ({ ...choice, value: i })),
          })
        ).pipe(
          Effect.provide(BunServices.layer),
          Effect.mapError(() => new Aborted())
        ),
    })
  );
}

const colorFor = (stream: NodeJS.WriteStream) =>
  ((tone, value) => styleText(tone, value, { stream })) satisfies Paint;

export const formatElapsed = (elapsed: Duration.Duration) => {
  const ms = Duration.toMillis(elapsed);

  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
};

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${Number(value.toFixed(1))} ${units[unit]}`;
};

export const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
