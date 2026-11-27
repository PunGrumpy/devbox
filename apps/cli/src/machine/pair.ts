import { Effect, FileSystem, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";

import { Locations } from "../migrate/locations.ts";
import { Output } from "../output.ts";
import { MachineFile, machineFile, originFlag } from "./config.ts";
import { Host } from "./host.ts";
import { processEnv, settingsFor } from "./settings.ts";

export const Pairing = Schema.Struct({
  url: Schema.String.pipe(Schema.check(Schema.isPattern(/^https?:\/\/\S+$/))),
  token: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))),
});
export type Pairing = typeof Pairing.Type;

export const pairingUrl = (pairing: Pairing) =>
  `${pairing.url}/pair#token=${pairing.token}`;

const TailscaleSelf = Schema.fromJsonString(
  Schema.Struct({ Self: Schema.Struct({ DNSName: Schema.String }) })
);

// `t3 environment link` refuses plain http unless the host is a Tailscale address, and the bare
// hostname is not one. The MagicDNS name is, and it stays reachable only from the tailnet.
const tailscaleName = Effect.gen(function* () {
  const host = yield* Host;
  const status = yield* host.run(["tailscale", "status", "--self", "--json"], {
    timeoutMs: 5000,
  });
  if (status.code !== 0) return Option.none<string>();
  return Schema.decodeUnknownOption(TailscaleSelf)(status.stdout).pipe(
    Option.map((json) => json.Self.DNSName.replace(/\.$/, "")),
    Option.filter((name) => name !== "")
  );
});

export class PairFailed extends Schema.TaggedError<PairFailed>()("PairFailed", {
  message: Schema.String,
  hint: Schema.optional(Schema.String),
}) {}

export const pair = Command.make(
  "pair",
  {
    label: Flag.String("label").pipe(
      Flag.withDescription("name the server shows for this client"),
      Flag.withDefault("devbox")
    ),
    url: originFlag(
      "url",
      "origin to print in the link, for example a tunnel (default the public URL, then the Tailscale name)"
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("print {url, token} on stdout"),
      Flag.withDefault(false)
    ),
  },
  ({ label, url: origin, json }) =>
    Effect.gen(function* () {
      const { home } = yield* Locations;
      const host = yield* Host;
      const out = yield* Output;
      const fs = yield* FileSystem.FileSystem;
      const file = machineFile(home);
      const machine = yield* fs.readFileString(file).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(MachineFile))
        ),
        Effect.mapError(
          () =>
            new PairFailed({
              message: `cannot read ${file}`,
              hint: "run `devbox up` on this machine first",
            })
        )
      );
      const minted = yield* host.run(
        [
          machine.t3,
          "pair",
          "--base-dir",
          machine.baseDir,
          "--ttl",
          "15m",
          "--label",
          label,
        ],
        {
          env: {
            ...processEnv(settingsFor(machine.data), process.env.PATH ?? ""),
            T3CODE_HOME: machine.baseDir,
          },
        }
      );
      const token = /^Token: (\S+)$/m.exec(minted.stdout)?.[1];
      if (minted.code !== 0 || token === undefined)
        return yield* new PairFailed({
          message: "t3 pair printed no token",
          hint:
            minted.stderr.trim() || "is T3 Code running? `devbox up` starts it",
        });
      const url = yield* Option.match(
        Option.orElse(origin, () => Option.fromUndefinedOr(machine.url)),
        {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.map(
              tailscaleName,
              (name) =>
                `http://${Option.getOrElse(name, () => host.hostname)}:${machine.port}`
            ),
        }
      );
      const pairing: Pairing = { url, token };
      if (json) return yield* out.json(pairing);
      yield* out.pairs([
        ["url", pairing.url],
        ["token", pairing.token],
        ["pairing url", pairingUrl(pairing)],
      ]);
    })
).pipe(
  Command.withDescription(
    "Print this machine's T3 Code URL and a one-time pairing token (15 minutes)"
  )
);
