import path from "node:path";

import { Option } from "effect";

export const TUNNEL_UNIT = "cloudflared-t3.service";

/** Where the tunnel's run token lives. `devbox up` only asks whether it is there. */
export const tunnelTokenFile = (home: string) =>
  path.join(home, ".config", "cloudflared", "token");

export const cloudflaredPath = (home: string) =>
  path.join(home, ".local", "bin", "cloudflared");

/** A tunnel run token, as Cloudflare hands it out: base64 and nothing a shell or a file would split. */
export const isTunnelToken = (token: string): boolean =>
  /^[A-Za-z0-9+/_=-]{1,2048}$/.test(token);

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

/** An https origin with a host name and nothing else: no port, path, query or credentials. */
export const isTunnelUrl = (url: string): boolean =>
  new RegExp(`^https://${LABEL}(?:\\.${LABEL})+$`).test(url);

/**
 * The recorded flags of `devbox up` with the tunnel on at `url`, or off when there is none. Any
 * `--public-url` already there gives way, since the tunnel's address is where T3 is reached now.
 */
export const withTunnel = (
  up: readonly string[],
  url: Option.Option<string>
): readonly string[] => {
  const kept = up.filter(
    (arg, i) =>
      arg !== "--tunnel" &&
      arg !== "--public-url" &&
      up[i - 1] !== "--public-url" &&
      !arg.startsWith("--public-url=")
  );

  return Option.match(url, {
    onNone: () => kept,
    onSome: (origin) => [...kept, "--tunnel", "--public-url", origin],
  });
};
