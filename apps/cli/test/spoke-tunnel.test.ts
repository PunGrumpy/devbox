import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";

import type { Ran } from "../src/machine/host.ts";
import { freePort } from "../src/machine/proxy.ts";
import { publicKeyOf, signRequest } from "../src/spoke/signed.ts";
import type { Do, Fields, Signed } from "../src/spoke/signed.ts";
import { makeMachine, SELF } from "./support/host.ts";
import { devbox, start } from "./support/run.ts";

const hubKey = generateKeyPairSync("ed25519").privateKey;
const KEY = publicKeyOf(hubKey);

const TOKEN = Buffer.from(
  JSON.stringify({ a: "made-up", t: "made-up", s: "made-up" })
).toString("base64");

const URL = "https://t3-edge-7.example.com";
const TAILNET = "tailscale-ip-21";

type Machine = ReturnType<typeof makeMachine>;

const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "" });

const setUpMachine = async () => {
  const m = makeMachine({ userBus: true });
  const installed = join(m.base, "cloudflared");
  mkdirSync(join(m.home, ".local", "bin"), { recursive: true });
  writeFileSync(join(m.home, ".local", "bin", "mise"), "");
  m.respond = (argv) => {
    if (argv[0] === "systemd-detect-virt") {
      return ok("kvm\n");
    }

    if (argv[0]?.endsWith("/mise") && argv[1] === "use") {
      return (writeFileSync(installed, ""), ok());
    }

    if (argv[0]?.endsWith("/mise") && argv[1] === "which") {
      return ok(`${installed}\n`);
    }

    return undefined;
  };

  const r = await up(
    m,
    "--spoke",
    "--trust",
    KEY,
    "--name",
    "edge-7",
    "--no-setup"
  );

  expect(r.code).toBe(0);

  return m;
};

const up = (m: Machine, ...args: readonly string[]) =>
  devbox({ HOME: m.home, PATH: "/usr/bin:/bin" }, ["up", ...args], {
    host: m.host,
  });

const running = async (m: Machine) => {
  const port = await Effect.runPromise(freePort);

  const spoke = start(
    { HOME: m.home },
    ["spoke", "--port", String(port), "--trust", KEY],
    {
      host: m.host,
    }
  );

  for (let i = 0; i < 100 && !spoke.err().includes("spoke:"); i += 1) {
    await Bun.sleep(20);
  }

  return { spoke, base: `http://127.0.0.1:${port}` };
};

const signedFor = async (base: string, action: Do, fields: Fields = {}) => {
  const { nonce } = (await (await fetch(`${base}/api/challenge`)).json()) as {
    nonce: string;
  };

  return signRequest(hubKey, new Date(), nonce, action, fields);
};

const send = (base: string, signed: Signed) =>
  fetch(`${base}/api/do`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed.headers },
    body: signed.body,
  });

const ask = async (base: string, action: Do, fields: Fields = {}) =>
  send(base, await signedFor(base, action, fields));

const tokenPath = (m: Machine) =>
  join(m.home, ".config", "cloudflared", "token");

const machineJson = (m: Machine) =>
  readFileSync(join(m.home, ".config/devbox/machine.json"), "utf-8");

const recorded = (m: Machine): readonly string[] =>
  JSON.parse(machineJson(m)).up;

const seen = new WeakMap<Machine, number>();

const started = (m: Machine) => {
  const runs = m.calls.filter(
    (argv) => argv[0] === "<detached>" && argv[SELF.length + 1] === "up"
  );

  const from = seen.get(m) ?? 0;
  seen.set(m, runs.length);
  m.processes = m.processes.filter((p) => p.argv[SELF.length] !== "up");

  return runs.slice(from).map((argv) => argv.slice(SELF.length + 2));
};

const finish = async (m: Machine, flags: readonly string[]) => {
  const r = await up(m, ...flags);
  expect(r.code).toBe(0);

  return r;
};

describe("a tunnel request", async () => {
  const m = await setUpMachine();
  const before = [...recorded(m), "--public-url", "https://old.example.com"];
  writeFileSync(
    join(m.home, ".config/devbox/machine.json"),
    JSON.stringify({ ...JSON.parse(machineJson(m)), up: before })
  );
  const { spoke, base } = await running(m);
  afterAll(() => spoke.stop());

  test("saves the token for this user alone and runs devbox up with the tunnel at the address", async () => {
    const response = await ask(base, "tunnel", { token: TOKEN, url: URL });
    expect(response.status).toBe(202);
    expect(readFileSync(tokenPath(m), "utf-8")).toBe(TOKEN);
    expect(statSync(tokenPath(m)).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(m.home, ".config", "cloudflared"))).toEqual([
      "token",
    ]);
    const [flags] = started(m);
    expect(flags).toEqual([
      ...before.slice(0, -2),
      "--tunnel",
      "--public-url",
      URL,
    ]);
    expect(flags!.filter((arg) => arg === "--public-url")).toHaveLength(1);

    const r = await finish(m, flags!);
    expect(r.err).toContain("enabled cloudflared-t3.service");
    expect(m.units.get("user:cloudflared-t3.service")).toEqual({
      active: true,
      enabled: true,
    });
    expect(recorded(m)).toContain("--tunnel");
    expect(JSON.parse(machineJson(m)).url).toBe(URL);
  });

  test("asked twice, it saves the same token and runs the same devbox up, which changes nothing", async () => {
    const response = await ask(base, "tunnel", { token: TOKEN, url: URL });
    expect(response.status).toBe(202);
    const [flags] = started(m);
    expect(
      flags!.filter((arg) => arg === "--tunnel" || arg === "--public-url")
    ).toEqual(["--tunnel", "--public-url"]);
    expect((await finish(m, flags!)).err).toContain("No changes.");
  });

  test("asked while a devbox up runs, it changes nothing", async () => {
    expect((await ask(base, "update")).status).toBe(202);
    writeFileSync(tokenPath(m), "the token cloudflared runs with");
    const response = await ask(base, "tunnel", { token: TOKEN, url: URL });
    expect(response.status).toBe(409);
    expect(readFileSync(tokenPath(m), "utf-8")).toBe(
      "the token cloudflared runs with"
    );
    started(m);
    writeFileSync(tokenPath(m), TOKEN);
  });

  test("the token is in no log, no reply, no machine.json and on no command line", () => {
    expect(spoke.err()).toContain(
      `the hub asked to publish this machine at ${URL}`
    );
    expect(`${spoke.out()}${spoke.err()}`).not.toContain(TOKEN);
    expect(machineJson(m)).not.toContain(TOKEN);
    expect(JSON.stringify(m.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(m.runs)).not.toContain(TOKEN);
    expect(JSON.stringify([...m.stdin.values()])).not.toContain(TOKEN);
  });

  test("an untunnel deletes the token and runs devbox up without the tunnel or its address", async () => {
    const response = await ask(base, "untunnel");
    expect(response.status).toBe(202);
    expect(existsSync(tokenPath(m))).toBe(false);
    const [flags] = started(m);
    expect(flags).not.toContain("--tunnel");
    expect(flags).not.toContain("--public-url");
    expect(flags).toContain("--spoke");
    expect(spoke.err()).toContain(
      "the hub asked to take this machine off the internet"
    );

    const r = await finish(m, flags!);
    expect(r.err).toContain(
      "removed cloudflared-t3.service, because --tunnel is off"
    );
    expect(JSON.parse(machineJson(m))).not.toHaveProperty("url");
  });

  test("an untunnel asked twice runs a devbox up that changes nothing", async () => {
    expect((await ask(base, "untunnel")).status).toBe(202);
    const [flags] = started(m);
    expect((await finish(m, flags!)).err).toContain("No changes.");
  });

  test("a tunnel request replayed after an untunnel is refused, and puts no token back", async () => {
    const signed = await signedFor(base, "tunnel", { token: TOKEN, url: URL });
    expect((await send(base, signed)).status).toBe(202);
    started(m);
    expect((await ask(base, "untunnel")).status).toBe(202);
    started(m);
    const replayed = await send(base, signed);
    expect(replayed.status).toBe(403);
    expect(existsSync(tokenPath(m))).toBe(false);
    expect(started(m)).toEqual([]);
  });

  test("the url cannot be changed without the hub's key", async () => {
    const signed = await signedFor(base, "tunnel", { token: TOKEN, url: URL });

    const response = await send(base, {
      ...signed,
      body: signed.body.replace(URL, "https://t3-edge-7.example.net"),
    });

    expect(response.status).toBe(403);
    expect(existsSync(tokenPath(m))).toBe(false);
  });

  test.each([
    [{ url: URL }, "token"],
    [{ token: "", url: URL }, "token"],
    [{ token: `${TOKEN}\nExecStartPre=/bin/sh -c id`, url: URL }, "token"],
    [{ token: "$(touch /tmp/owned)", url: URL }, "token"],
    [{ token: "a; rm -rf ~", url: URL }, "token"],
    [{ token: TOKEN }, "https"],
    [{ token: TOKEN, url: "http://t3-edge-7.example.com" }, "https"],
    [{ token: TOKEN, url: `${URL}/` }, "https"],
    [{ token: TOKEN, url: `${URL}/pair` }, "https"],
    [{ token: TOKEN, url: `${URL}:8443` }, "https"],
    [{ token: TOKEN, url: `${URL}?next=evil` }, "https"],
    [{ token: TOKEN, url: "https://user:pass@t3-edge-7.example.com" }, "https"],
    [
      { token: TOKEN, url: "https://t3-edge-7.example.com@evil.example.net" },
      "https",
    ],
    [{ token: TOKEN, url: `${URL} --hub` }, "https"],
    [{ token: TOKEN, url: "https://localhost" }, "https"],
  ] satisfies readonly (readonly [Fields, string])[])(
    "%p is refused, and nothing is saved or started",
    async (fields, names) => {
      const response = await ask(base, "tunnel", fields);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(
        names
      );
      expect(existsSync(tokenPath(m))).toBe(false);
      expect(started(m)).toEqual([]);
    }
  );
});

test("a machine devbox up has not recorded saves no token", async () => {
  const m = makeMachine();
  const { spoke, base } = await running(m);

  try {
    const response = await ask(base, "tunnel", { token: TOKEN, url: URL });
    expect(response.status).toBe(409);
    expect(existsSync(tokenPath(m))).toBe(false);
  } finally {
    await spoke.stop();
  }
});

test("a machine on its Tailscale address keeps it, so the hub still reaches the spoke", async () => {
  const m = makeMachine({ userBus: true });
  m.respond = (argv) =>
    argv[0] === "systemd-detect-virt" ? ok("kvm\n") : undefined;
  await up(m, "--spoke", "--trust", KEY, "--host", TAILNET, "--no-setup");
  const { spoke, base } = await running(m);

  try {
    expect((await ask(base, "tunnel", { token: TOKEN, url: URL })).status).toBe(
      202
    );
    const [flags] = started(m);
    expect(
      flags!.slice(flags!.indexOf("--host"), flags!.indexOf("--host") + 2)
    ).toEqual(["--host", TAILNET]);
  } finally {
    await spoke.stop();
  }
});
