import { Data, Effect, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Output } from "../output.ts";
import { Host } from "./host.ts";
import { Pairing, pairingUrl } from "./pair.ts";

const ACCESS = [
  "read-only",
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;

export class LinkFailed extends Schema.TaggedError<LinkFailed>()("LinkFailed", {
  failed: Schema.Number,
}) {
  override get message() {
    return `${this.failed} of the machines did not link`;
  }
}

export const appLink = (url: string) => `t3code://pair?pairingUrl=${encodeURIComponent(url)}`;

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

type AppRoute = Data.TaggedEnum<{
  Clipboard: {};
  Scheme: { readonly opener: string };
}>;
const AppRoute = Data.taggedEnum<AppRoute>();

const appRoute = Effect.gen(function* () {
  const host = yield* Host;
  if (yield* host.which("clip.exe")) return AppRoute.Clipboard();
  return AppRoute.Scheme({ opener: process.platform === "darwin" ? "open" : "xdg-open" });
});

const remotePairing = (target: string, label: string) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const ran = yield* host.run([
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "--",
      target,
      `~/.local/bin/devbox pair --json --label ${shellQuote(label)}`,
    ]);
    if (ran.code !== 0) return yield* Effect.fail(`devbox pair failed there: ${ran.stderr.trim()}`);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Pairing))(ran.stdout).pipe(
      Effect.mapError(() => `devbox pair printed something other than {url, token}`),
    );
  });

const toApp = (target: string, url: string, route: AppRoute) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const out = yield* Output;
    yield* AppRoute.$match(route, {
      Clipboard: () =>
        Effect.gen(function* () {
          if ((yield* host.run(["clip.exe"], { stdin: url })).code !== 0)
            return yield* Effect.fail("clip.exe failed");
          yield* out.log(
            `${target}: pairing URL copied. In T3 Code, Settings -> Connections -> Add environment, paste it, then press Enter here.`,
          );
          yield* host.readLine;
        }),
      Scheme: ({ opener }) =>
        Effect.gen(function* () {
          if ((yield* host.run([opener, appLink(url)])).code !== 0)
            return yield* Effect.fail(`${opener} failed`);
          yield* out.log(`${target}: confirm "Add the backend" in the T3 Code app`);
        }),
    });
  });

export const link = Command.make(
  "link",
  {
    app: Flag.Boolean("app").pipe(
      Flag.withDescription("also add each machine to the T3 Code app on this computer"),
      Flag.withDefault(false),
    ),
    access: Flag.Literals("access", ACCESS).pipe(
      Flag.withDescription("what agents here may do there"),
      Flag.withDefault("full-access"),
    ),
    t3: Flag.String("t3").pipe(
      Flag.withDescription("t3 binary on this computer"),
      Flag.withDefault("t3"),
    ),
    targets: Argument.String("ssh-host").pipe(
      Argument.withDescription("SSH host of a machine set up with devbox up"),
      Argument.variadic({ min: 1 }),
    ),
  },
  ({ app, access, t3, targets }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const out = yield* Output;
      const label = host.hostname.split(".")[0] ?? host.hostname;
      const route = yield* appRoute;
      let failed = 0;
      for (const target of targets) {
        const result = yield* Effect.gen(function* () {
          const pairing = yield* remotePairing(target, label);
          const linked = yield* host.run(
            [
              t3,
              "environment",
              "link",
              pairing.url,
              "--pairing-code",
              pairing.token,
              "--access",
              access,
            ],
            { inherit: true },
          );
          if (linked.code !== 0)
            return yield* Effect.fail(`t3 environment link exited with ${linked.code}`);
          yield* out.check(true, `${target}: linked ${pairing.url} for agents here`);
          if (!app) return;
          const forApp = yield* remotePairing(target, `${label} app`);
          yield* toApp(target, pairingUrl(forApp), route);
        }).pipe(Effect.result);
        if (result._tag === "Failure") {
          failed += 1;
          yield* out.check(false, target, result.failure);
        }
      }
      if (failed > 0) return yield* Effect.fail(new LinkFailed({ failed }));
    }),
).pipe(
  Command.withDescription(
    "Link machines as T3 environments on this computer, over SSH, with no pairing code to copy. Run it again to renew.",
  ),
);
