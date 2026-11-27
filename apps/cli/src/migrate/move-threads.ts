import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { SqlClient } from "effect/sql";

import { UsageError } from "../errors.ts";
import { Output, plural } from "../output.ts";
import { inMigrate, writeFlags } from "./command.ts";
import {
  assertEventsEmpty,
  assertSchema,
  BASE_SCHEMA,
  count,
  databaseLayer,
  resolveProject,
  Tables,
} from "./database.ts";
import type { Project } from "./database.ts";
import { applyPlan, Change } from "./plan.ts";
import { assertT3Closed } from "./t3-process.ts";

const SCHEMA = {
  ...BASE_SCHEMA,
  [Tables.scheduledTasks]: ["task_id", "project_id"],
};

const ThreadRow = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  updatedAt: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
});

type ThreadRow = typeof ThreadRow.Type;

const threadsOf = (projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* count(
      sql`SELECT count(*) AS n FROM ${sql(Tables.threads)} WHERE project_id = ${projectId}`
    );
  });

export const moveThreads = Command.make(
  "move-threads",
  {
    to: Flag.String("to").pipe(
      Flag.withDescription("project that receives the threads, by id or title")
    ),
    from: Flag.String("from").pipe(
      Flag.withDescription(
        "project to take threads from, by id or title; repeat for more"
      ),
      Flag.atLeast(1)
    ),
    thread: Flag.String("thread").pipe(
      Flag.withDescription("move only this thread id"),
      Flag.optional
    ),
    ...writeFlags,
  },
  ({ to, from, thread, apply, yes }) =>
    inMigrate((target) =>
      Effect.gen(function* () {
        const out = yield* Output;
        const sql = yield* SqlClient.SqlClient;

        if (apply && target._tag === "Live") {
          yield* assertT3Closed;
        }

        yield* assertSchema(SCHEMA);
        yield* assertEventsEmpty;
        const into = yield* resolveProject(to);

        const sources: readonly Project[] = yield* Effect.forEach(
          from,
          resolveProject
        );

        if (sources.some((source) => source.projectId === into.projectId)) {
          return yield* new UsageError({
            message: `--from and --to both name "${into.title}"`,
          });
        }

        if (into.deletedAt !== null && into.deletedAt !== "") {
          yield* out.warn(
            `target project "${into.title}" is deleted; its threads would stay hidden`
          );
        }

        const sourceIds = sources.map((source) => source.projectId);

        const selected = sql.and([
          sql.in("project_id", sourceIds),
          ...Option.match(thread, {
            onNone: () => [],
            onSome: (id) => [sql`thread_id = ${id}`],
          }),
        ]);

        const rows = yield* sql`
          SELECT thread_id AS threadId, title, project_id AS projectId, updated_at AS updatedAt, deleted_at AS deletedAt
          FROM ${sql(Tables.threads)} WHERE ${selected} ORDER BY updated_at DESC`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ThreadRow)))
        );

        if (Option.isSome(thread) && rows.length === 0) {
          return yield* new UsageError({
            message: `thread ${thread.value} is not in ${sources.map((source) => source.title).join(", ")}`,
          });
        }

        const titles = new Map(
          sources.map((source) => [source.projectId, source.title])
        );

        const dim = (text: string) => out.paint("dim", text);

        const dimCount = (n: number) => dim(`(${n})`);

        const counted = yield* Effect.forEach(sources, (source) =>
          Effect.map(
            threadsOf(source.projectId),
            (n) => `${source.title} ${dimCount(n)}`
          )
        );

        const intoBefore = yield* threadsOf(into.projectId);
        yield* out.log(`${dim("from")} ${counted.join(", ")}`);
        yield* out.log(`${dim("to  ")} ${into.title} ${dimCount(intoBefore)}`);
        yield* out.line();

        if (rows.length > 0) {
          yield* out.table<ThreadRow>(
            [
              {
                header: "thread",
                cell: (r) => ({ text: r.threadId.slice(0, 8), tone: "dim" }),
              },
              {
                header: "title",
                cell: (r) =>
                  r.deletedAt === null || r.deletedAt === ""
                    ? r.title
                    : { text: r.title, tone: "gray" },
              },
              {
                header: "from",
                cell: (r) => ({
                  text: titles.get(r.projectId) ?? r.projectId,
                  tone: "dim",
                }),
              },
              {
                header: "updated",
                cell: (r) => ({ text: r.updatedAt.slice(0, 10), tone: "dim" }),
              },
            ],
            rows
          );
          yield* out.line();
        }

        const tasks = yield* count(
          sql`SELECT count(*) AS n FROM ${sql(Tables.scheduledTasks)} WHERE ${sql.in("project_id", sourceIds)}`
        );

        if (tasks > 0) {
          yield* out.warn(
            `${plural(tasks, "scheduled task")} still point at the source projects; this command leaves them`
          );
        }

        yield* out.log(`${plural(rows.length, "thread")} to move`);

        if (rows.length === 0) {
          return;
        }

        const ids = rows.map((row) => row.threadId);
        yield* applyPlan(
          target,
          { apply, yes },
          {
            change: Change.MoveThreads({
              threads: rows.length,
              into: into.title,
            }),
            prepare: Effect.void,
            write: sql`UPDATE ${sql(Tables.threads)}
            SET project_id = ${into.projectId}, payload_json = json_set(payload_json, '$.projectId', ${into.projectId})
            WHERE ${selected}`.pipe(Effect.asVoid),
            verify: [
              {
                what: "threads left on the source projects",
                expected: 0,
                actual: count(
                  sql`SELECT count(*) AS n FROM ${sql(Tables.threads)} WHERE ${selected}`
                ),
              },
              {
                what: `threads in ${into.title}`,
                expected: intoBefore + rows.length,
                actual: threadsOf(into.projectId),
              },
              {
                what: "moved threads whose payload projectId differs from project_id",
                expected: 0,
                actual:
                  count(sql`SELECT count(*) AS n FROM ${sql(Tables.threads)}
                WHERE ${sql.in("thread_id", ids)} AND json_extract(payload_json, '$.projectId') IS NOT project_id`),
              },
            ],
          }
        );
      }).pipe(
        Effect.provide(databaseLayer(target.path, apply ? "write" : "read"))
      )
    )
).pipe(
  Command.withDescription("Move threads from one or more projects into another")
);
