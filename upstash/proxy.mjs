// Upstash's preview proxy passes the box's internal address (172.x:3773) to
// T3 as the Host header. T3 builds its MCP OAuth URLs from Host, so linking
// the box from the Mac fails: "This server only issues tokens for
// http://172.x:3773/mcp". This proxy listens on the preview port, sets Host to
// the public preview host, and passes HTTP and WebSocket traffic to T3.
// Usage: node proxy.mjs <listen port> <T3 port> <public host>
import http from "node:http";
import net from "node:net";

const [listenPort, t3Port, publicHost] = process.argv.slice(2);

// Requests from the box itself (an SSH tunnel, curl) keep their own Host.
const rewrite = (headers) => {
  if (/^(localhost|127\.0\.0\.1)(:|$)/.test(headers.host ?? "")) return headers;
  return { ...headers, host: publicHost, "x-forwarded-proto": "https" };
};

const server = http.createServer((req, res) => {
  const upstream = http.request(
    { host: "127.0.0.1", port: t3Port, method: req.method, path: req.url, headers: rewrite(req.headers) },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.rawHeaders);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(t3Port, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(rewrite(req.headers))) {
      for (const v of [value].flat()) lines.push(`${key}: ${v}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    upstream.write(head);
    upstream.pipe(socket).pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(Number(listenPort), "0.0.0.0");
