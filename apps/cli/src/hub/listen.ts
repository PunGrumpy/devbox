import http from "node:http";

import { Effect, Schema } from "effect";

export class ListenFailed extends Schema.TaggedError<ListenFailed>()(
  "ListenFailed",
  {
    message: Schema.String,
    hint: Schema.optional(Schema.String),
  }
) {}

/** An HTTP server on `host:port` for as long as the scope lasts. */
export const listen = (
  host: string,
  port: number,
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => void
) =>
  Effect.acquireRelease(
    Effect.callback<http.Server, ListenFailed>((resume) => {
      const server = http.createServer(handle);
      server.once("error", (error: NodeJS.ErrnoException) =>
        resume(
          Effect.fail(
            new ListenFailed({
              message: `cannot listen on ${host}:${port}: ${error.code ?? error.message}`,
              hint: "pass another --port, or an address this machine has to --host",
            })
          )
        )
      );
      server.listen(port, host, () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      })
  );

/** The first value of a request header. */
export const header = (
  req: http.IncomingMessage,
  name: string
): string | undefined => {
  const value = req.headers[name];

  return Array.isArray(value) ? value[0] : value;
};

/** The body as text, or null once it grows past `limit` bytes, which are all that is ever read. */
export const readBody = (req: http.IncomingMessage, limit: number) =>
  new Promise<string | null>((resolve) => {
    if (Number(header(req, "content-length") ?? 0) > limit) {
      return resolve(null);
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;

      if (size > limit) {
        req.removeAllListeners("data");
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => resolve(null));
  });
