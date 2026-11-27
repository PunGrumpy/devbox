import { Data, Effect, Schema, Scope } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

import { Aborted } from "../errors.ts";
import { formatBytes, Output, plural } from "../output.ts";
import { backup, type DbTarget, quickCheck, restoreHint } from "./database.ts";

export type Change = Data.TaggedEnum<{
  MoveThreads: { readonly threads: number; readonly into: string };
  RenameRoot: { readonly project: string; readonly to: string };
}>;
export const Change = Data.taggedEnum<Change>();

const sentence = Change.$match({
  MoveThreads: ({ threads, into }) =>
    `move ${plural(threads, "thread")} into ${into}`,
  RenameRoot: ({ project, to }) => `rename the root of ${project} to ${to}`,
});

const question = Change.$match({
  MoveThreads: ({ threads, into }) =>
    `Move ${plural(threads, "thread")} into ${into}?`,
  RenameRoot: ({ project, to }) => `Rename the root of ${project} to ${to}?`,
});

type Value = number | string;

export type Expectation = {
  readonly what: string;
  readonly expected: Value;
  readonly actual: Effect.Effect<
    Value,
    SqlError.SqlError | Schema.SchemaError,
    SqlClient.SqlClient
  >;
};

type Mismatch = {
  readonly what: string;
  readonly expected: Value;
  readonly actual: Value;
};

export class WriteFailed extends Schema.TaggedError<WriteFailed>()(
  "WriteFailed",
  {
    reason: Schema.String,
    restore: Schema.String,
  }
) {
  override get message() {
    return `write failed: ${this.reason}`;
  }
  get hint() {
    return this.restore;
  }
}

export class VerificationFailed extends Schema.TaggedError<VerificationFailed>()(
  "VerificationFailed",
  {
    mismatches: Schema.Array(
      Schema.Struct({
        what: Schema.String,
        expected: Schema.Union([Schema.Number, Schema.String]),
        actual: Schema.Union([Schema.Number, Schema.String]),
      })
    ),
    restore: Schema.String,
  }
) {
  override get message() {
    const lines = this.mismatches.map(
      (m) =>
        `${m.what} is ${JSON.stringify(m.actual)}, expected ${JSON.stringify(m.expected)}`
    );
    return `verification failed: ${lines.join("; ")}`;
  }
  get hint() {
    return this.restore;
  }
}

export type Plan<E, R> = {
  readonly change: Change;
  readonly prepare: Effect.Effect<void, E, R | Scope.Scope>;
  readonly write: Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>;
  readonly verify: ReadonlyArray<Expectation>;
};

export type Mode = { readonly apply: boolean; readonly yes: boolean };

export const applyPlan = <E, R>(
  target: DbTarget,
  mode: Mode,
  plan: Plan<E, R>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const out = yield* Output;
      if (!mode.apply) {
        return yield* out.note(
          `dry run. Re-run with ${out.paint("dim", "--apply")} to ${sentence(plan.change)}.`
        );
      }
      if (!mode.yes && !(yield* out.confirm(question(plan.change))))
        return yield* new Aborted();
      yield* plan.prepare;
      const sql = yield* SqlClient.SqlClient;
      const [elapsed] = yield* Effect.timed(
        Effect.gen(function* () {
          const before = yield* out.step("quick_check before", quickCheck);
          if (before !== "ok")
            yield* out.warn(
              `quick_check before the change is not clean: ${before}`
            );
          const saved = yield* out.step("backup", backup(target.path));
          yield* out.log(
            `backup ${saved.path} ${out.paint("dim", `(${formatBytes(saved.bytes)})`)}`
          );
          const restore = restoreHint(saved.path, target.path);
          yield* sql
            .withTransaction(plan.write)
            .pipe(
              Effect.mapError(
                (error) => new WriteFailed({ reason: error.message, restore })
              )
            );
          const checks = [
            ...plan.verify,
            { what: "quick_check", expected: before, actual: quickCheck },
          ];
          const mismatches: Array<Mismatch> = [];
          for (const check of checks) {
            const actual = yield* check.actual;
            if (actual !== check.expected)
              mismatches.push({
                what: check.what,
                expected: check.expected,
                actual,
              });
          }
          if (mismatches.length > 0)
            return yield* new VerificationFailed({ mismatches, restore });
        })
      );
      yield* out.success(
        `${sentence(plan.change)}. Relaunch T3 Code to see the change.`,
        elapsed
      );
    })
  );
