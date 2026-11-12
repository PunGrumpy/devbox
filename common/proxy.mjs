// Some machines put a proxy in front of T3 that passes T3 an internal address
// as the Host header (Upstash: 172.x:3773, instabox: 127.0.0.1:3774). T3
// builds its MCP OAuth URLs from Host, so linking the machine from the Mac
// fails: "This server only issues tokens for http://172.x:3773/mcp". This
// proxy listens on the port the machine's proxy reaches, sets Host to the
// public host, and passes HTTP and WebSocket traffic to T3.
// Usage: node proxy.mjs <listen port> <T3 port> <public host>
import http from "node:http";
import net from "node:net";

const [listenPort, t3Port, publicHost] = process.argv.slice(2);

// Only requests that came through the machine's proxy carry X-Forwarded-*.
// Use its X-Forwarded-Host when it sends one. Requests made on the machine
// itself (an SSH tunnel, curl) keep their own Host.
const rewrite = (headers) => {
  if (!headers["x-forwarded-host"] && !headers["x-forwarded-proto"]) return headers;
  const host = headers["x-forwarded-host"] || publicHost;
  return { ...headers, host, "x-forwarded-proto": "https" };
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
