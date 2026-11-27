import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import net from "node:net";

import { Effect, Option, Schema } from "effect";

/** T3 Code builds its OAuth issuer from Host and honours X-Forwarded-Proto but not X-Forwarded-Host. */
export const rewriteHeaders = (
  headers: IncomingHttpHeaders,
  publicUrl: string
) => {
  if (
    headers["x-forwarded-host"] === undefined &&
    headers["x-forwarded-proto"] === undefined
  ) {
    return headers;
  }

  const url = new URL(publicUrl);

  const forwarded = [headers["x-forwarded-host"]]
    .flat()[0]
    ?.split(",")[0]
    ?.trim();

  return {
    ...headers,
    host: forwarded === undefined || forwarded === "" ? url.host : forwarded,
    "x-forwarded-proto": url.protocol.replace(":", ""),
  } satisfies IncomingHttpHeaders;
};

const ListeningAt = Schema.decodeUnknownOption(
  Schema.Struct({ port: Schema.Number })
);

export const freePort = Effect.callback<number>((resume) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = Option.match(ListeningAt(server.address()), {
      onNone: () => 0,
      onSome: (address) => address.port,
    });

    server.close(() => {
      resume(Effect.succeed(port));
    });
  });
});

export const proxy = (options: {
  readonly host: string;
  readonly port: number;
  readonly upstream: number;
  readonly publicUrl: string;
}) =>
  Effect.acquireRelease(
    Effect.callback<http.Server>((resume) => {
      const { upstream, publicUrl } = options;

      const server = http.createServer((req, res) => {
        const forward = http.request(
          {
            host: "127.0.0.1",
            port: upstream,
            method: req.method,
            path: req.url,
            headers: rewriteHeaders(req.headers, publicUrl),
          },
          (reply) => {
            res.writeHead(reply.statusCode ?? 502, reply.rawHeaders);
            reply.pipe(res);
          }
        );

        forward.on("error", () => {
          if (!res.headersSent) {
            res.writeHead(502);
          }

          res.end();
        });
        req.on("error", () => {
          forward.destroy();
        });
        req.pipe(forward);
      });

      server.on("upgrade", (req, socket, head) => {
        const forward = net.connect(upstream, "127.0.0.1", () => {
          const lines = [`${req.method} ${req.url} HTTP/1.1`];

          for (const [key, value] of Object.entries(
            rewriteHeaders(req.headers, publicUrl)
          )) {
            for (const v of [value ?? []].flat()) {
              lines.push(`${key}: ${v}`);
            }
          }

          forward.write(`${lines.join("\r\n")}\r\n\r\n`);
          forward.write(head);
          forward.pipe(socket).pipe(forward);
        });

        forward.on("error", () => {
          if (forward.connecting) {
            socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
          } else {
            socket.destroy();
          }
        });
        socket.on("error", () => {
          forward.destroy();
        });
      });
      server.once("error", (error) => {
        resume(Effect.die(error));
      });
      server.listen(options.port, options.host, () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.callback((resume) => {
        server.closeAllConnections();
        server.close(() => {
          resume(Effect.void);
        });
      })
  );
