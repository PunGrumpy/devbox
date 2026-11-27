import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Ran } from "../src/machine/host.ts";
import { appLink } from "../src/machine/link.ts";
import { makeMachine } from "./support/host.ts";
import { devbox } from "./support/run.ts";

const T3_PAIR_OUTPUT = `Pairing with edge-7 (http://127.0.0.1:3773).

  ▄▄▄ qr ▄▄▄

Pairing URL: http://127.0.0.1:3773/pair#token=KJJDV5SUA4NL
Token: KJJDV5SUA4NL
Expires: 2026-11-17T12:09:22.174Z
`;

const boxWith = (machine: object, tailscale?: Ran) => {
  const m = makeMachine();
  mkdirSync(join(m.home, ".config/devbox"), { recursive: true });
  writeFileSync(
    join(m.home, ".config/devbox/machine.json"),
    JSON.stringify(machine)
  );
  m.respond = (argv) => {
    if (argv[1] === "pair")
      return { code: 0, stdout: T3_PAIR_OUTPUT, stderr: "" };
    if (argv[0] === "tailscale") return tailscale;
    return undefined;
  };
  return m;
};

const tailscaleSelf = (self: unknown): Ran => ({
  code: 0,
  stdout: JSON.stringify({ BackendState: "Running", Self: self }),
  stderr: "",
});

const MACHINE = {
  name: "edge-7",
  url: "https://edge-7.example.com",
  port: 3773,
  data: "/d",
  baseDir: "/d/.t3",
  t3: "/d/.local/bin/t3",
};

describe("devbox pair", () => {
  test("--json prints exactly {url, token} on stdout", async () => {
    const m = boxWith(MACHINE);
    const r = await devbox(
      { HOME: m.home },
      ["pair", "--json", "--label", "laptop"],
      {
        host: m.host,
      }
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      url: "https://edge-7.example.com",
      token: "KJJDV5SUA4NL",
    });
    expect(m.calls).toEqual([
      [
        "/d/.local/bin/t3",
        "pair",
        "--base-dir",
        "/d/.t3",
        "--ttl",
        "15m",
        "--label",
        "laptop",
      ],
    ]);
  });

  test("without a public URL it offers the hostname and port", async () => {
    const m = boxWith({ ...MACHINE, url: undefined });
    const r = await devbox({ HOME: m.home }, ["pair", "--json"], {
      host: m.host,
    });
    expect(JSON.parse(r.out).url).toBe("http://box-1.example.internal:3773");
  });

  test("without a public URL it offers the Tailscale name, which t3 environment link accepts over http", async () => {
    const m = boxWith(
      { ...MACHINE, url: undefined },
      tailscaleSelf({ DNSName: "box-1.tail585c0b.ts.net.", HostName: "box-1" })
    );
    const r = await devbox({ HOME: m.home }, ["pair", "--json"], {
      host: m.host,
    });
    expect(JSON.parse(r.out).url).toBe("http://box-1.tail585c0b.ts.net:3773");
    expect(m.calls).toContainEqual(["tailscale", "status", "--self", "--json"]);
  });

  test("a public URL wins and Tailscale is not asked", async () => {
    const m = boxWith(
      MACHINE,
      tailscaleSelf({ DNSName: "box-1.tail585c0b.ts.net." })
    );
    const r = await devbox({ HOME: m.home }, ["pair", "--json"], {
      host: m.host,
    });
    expect(JSON.parse(r.out).url).toBe("https://edge-7.example.com");
    expect(m.calls.some((c) => c[0] === "tailscale")).toBe(false);
  });

  test("--url beats the Tailscale name and Tailscale is not asked", async () => {
    const m = boxWith(
      { ...MACHINE, url: undefined },
      tailscaleSelf({ DNSName: "box-1.tail585c0b.ts.net." })
    );
    const r = await devbox(
      { HOME: m.home },
      ["pair", "--json", "--url", "https://t.example.com"],
      {
        host: m.host,
      }
    );
    expect(JSON.parse(r.out)).toEqual({
      url: "https://t.example.com",
      token: "KJJDV5SUA4NL",
    });
    expect(m.calls.some((c) => c[0] === "tailscale")).toBe(false);
  });

  test("--url beats the saved public URL", async () => {
    const m = boxWith(MACHINE);
    const r = await devbox(
      { HOME: m.home },
      ["pair", "--json", "--url", "https://t.example.com"],
      {
        host: m.host,
      }
    );
    expect(JSON.parse(r.out).url).toBe("https://t.example.com");
  });

  test("--url drops a trailing slash from the pairing url", async () => {
    const m = boxWith(MACHINE);
    const r = await devbox(
      { HOME: m.home },
      ["pair", "--url", "https://t.example.com/"],
      {
        host: m.host,
      }
    );
    expect(r.err).toMatch(
      /^ *pairing url\s+https:\/\/t\.example\.com\/pair#token=KJJDV5SUA4NL$/m
    );
  });

  test.each(["https://t.example.com/path", "ftp://t.example.com"])(
    "--url %s is a usage error and mints no token",
    async (url) => {
      const m = boxWith(MACHINE);
      const r = await devbox({ HOME: m.home }, ["pair", "--url", url], {
        host: m.host,
      });
      expect(r.code).toBe(2);
      expect(r.err).toContain("expected an origin such as");
      expect(m.calls).toEqual([]);
    }
  );

  test.each([
    [
      "tailscale is not installed",
      { code: 127, stdout: "", stderr: "not found" },
    ],
    [
      "tailscale is down",
      { code: 1, stdout: "", stderr: "failed to connect to local tailscaled" },
    ],
    ["its output is not JSON", { code: 0, stdout: "Logged out.", stderr: "" }],
    [
      "it has no Self",
      {
        code: 0,
        stdout: JSON.stringify({ BackendState: "Stopped" }),
        stderr: "",
      },
    ],
    ["its DNSName is empty", tailscaleSelf({ DNSName: "" })],
    ["its DNSName is not a string", tailscaleSelf({ DNSName: 7 })],
  ])("when %s it keeps the hostname URL", async (_, tailscale) => {
    const m = boxWith({ ...MACHINE, url: undefined }, tailscale);
    const r = await devbox({ HOME: m.home }, ["pair", "--json"], {
      host: m.host,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).url).toBe("http://box-1.example.internal:3773");
  });

  test("it fails clearly before up has run, and when t3 prints no token", async () => {
    const fresh = makeMachine();
    const missing = await devbox({ HOME: fresh.home }, ["pair", "--json"], {
      host: fresh.host,
    });
    expect(missing.code).toBe(1);
    expect(missing.out).toBe("");
    expect(missing.err).toContain("run `devbox up` on this machine first");

    const m = boxWith(MACHINE);
    m.respond = () => ({ code: 1, stdout: "", stderr: "no server is running" });
    const noToken = await devbox({ HOME: m.home }, ["pair", "--json"], {
      host: m.host,
    });
    expect(noToken.code).toBe(1);
    expect(noToken.err).toContain("t3 pair printed no token");
    expect(noToken.err).toContain("no server is running");
  });
});

const sshAnswers = (
  m: ReturnType<typeof makeMachine>,
  stdout: (host: string) => string
) => {
  m.respond = (argv) => {
    if (argv[0] === "ssh")
      return { code: 0, stdout: stdout(argv[6]!), stderr: "" };
    if (
      argv[0] === "t3" ||
      argv[0] === "xdg-open" ||
      argv[0] === "open" ||
      argv[0] === "clip.exe"
    )
      return { code: 0, stdout: "", stderr: "" };
    return undefined;
  };
};

describe("devbox link", () => {
  test("decodes each box's pairing and links it for agents here", async () => {
    const m = makeMachine();
    sshAnswers(m, (host) =>
      JSON.stringify({ url: `https://${host}.example.com`, token: `T-${host}` })
    );
    const r = await devbox(
      { HOME: m.home },
      ["link", "--access", "read-only", "a", "b"],
      {
        host: m.host,
      }
    );
    expect(r.code).toBe(0);
    expect(m.calls.filter((c) => c[0] === "ssh")).toEqual([
      [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "--",
        "a",
        "~/.local/bin/devbox pair --json --label 'box-1'",
      ],
      [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "--",
        "b",
        "~/.local/bin/devbox pair --json --label 'box-1'",
      ],
    ]);
    expect(m.calls.filter((c) => c[0] === "t3")).toEqual([
      [
        "t3",
        "environment",
        "link",
        "https://a.example.com",
        "--pairing-code",
        "T-a",
        "--access",
        "read-only",
      ],
      [
        "t3",
        "environment",
        "link",
        "https://b.example.com",
        "--pairing-code",
        "T-b",
        "--access",
        "read-only",
      ],
    ]);
  });

  test.each([
    ["not json", "<url> <token>"],
    ["a missing token", JSON.stringify({ url: "https://a.example.com" })],
    [
      "a token with shell in it",
      JSON.stringify({ url: "https://a.example.com", token: "x; rm -rf ~" }),
    ],
    [
      "a URL that is not http",
      JSON.stringify({ url: "file:///etc/passwd", token: "T" }),
    ],
  ])("refuses %s and links nothing", async (_, stdout) => {
    const m = makeMachine();
    sshAnswers(m, () => stdout);
    const r = await devbox({ HOME: m.home }, ["link", "a"], { host: m.host });
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "devbox pair printed something other than {url, token}"
    );
    expect(m.calls.filter((c) => c[0] === "t3")).toEqual([]);
  });

  test("--app opens t3code:// with the pairing URL encoded as one component", async () => {
    const m = makeMachine();
    sshAnswers(m, () =>
      JSON.stringify({ url: "https://a.example.com:8443", token: "TOK" })
    );
    const r = await devbox({ HOME: m.home }, ["link", "--app", "a"], {
      host: m.host,
    });
    expect(r.code).toBe(0);
    const opened = m.calls.find((c) => c[0] === "xdg-open" || c[0] === "open")!;
    expect(opened[1]).toBe(
      "t3code://pair?pairingUrl=https%3A%2F%2Fa.example.com%3A8443%2Fpair%23token%3DTOK"
    );
    expect(appLink("https://x/pair#token=a&b=c")).toBe(
      "t3code://pair?pairingUrl=https%3A%2F%2Fx%2Fpair%23token%3Da%26b%3Dc"
    );
    expect(m.calls.filter((c) => c[0] === "ssh").map((c) => c[7])).toEqual([
      "~/.local/bin/devbox pair --json --label 'box-1'",
      "~/.local/bin/devbox pair --json --label 'box-1 app'",
    ]);
  });

  test("--app from WSL copies the pairing URL with clip.exe and waits for Enter", async () => {
    const m = makeMachine({ binaries: new Set(["clip.exe"]) });
    sshAnswers(m, () =>
      JSON.stringify({ url: "https://a.example.com", token: "TOK" })
    );
    const r = await devbox({ HOME: m.home }, ["link", "--app", "a"], {
      host: m.host,
    });
    expect(r.code).toBe(0);
    expect(m.stdin.get("clip.exe")).toBe(
      "https://a.example.com/pair#token=TOK"
    );
    expect(m.calls.at(-1)).toEqual(["<enter>"]);
    expect(r.err).toContain("pairing URL copied");
  });

  test("needs at least one host", async () => {
    const r = await devbox({}, ["link"]);
    expect(r.code).toBe(2);
  });
});
