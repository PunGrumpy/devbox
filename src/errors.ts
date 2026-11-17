import { Predicate, Runtime, Schema } from "effect";

export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
  hint: Schema.optional(Schema.String),
}) {
  override readonly [Runtime.errorExitCode] = 2;
}

export class NotATerminal extends Schema.TaggedError<NotATerminal>()("NotATerminal", {}) {
  override get message() {
    return "not a terminal, cannot ask for confirmation";
  }
  get hint() {
    return "pass --yes to skip the prompt";
  }
}

export class Aborted extends Schema.TaggedError<Aborted>()("Aborted", {}) {
  override get message() {
    return "aborted";
  }
}

export const hintOf = (error: unknown): string | undefined =>
  Predicate.hasProperty(error, "hint") && Predicate.isString(error.hint) ? error.hint : undefined;
