import { Effect, Option, Schema, Stdio, Stream } from "effect";
import { Command, Flag } from "effect/cli";

import { UsageError } from "../errors.ts";
import { Locations } from "../migrate/locations.ts";
import { Output } from "../output.ts";
import {
  CloudflareFailed,
  forgetCloudflare,
  loadCloudflare,
  saveCloudflare,
} from "./cloudflare-auth.ts";
import { loginCommand, type SignedIn } from "./cloudflare-oauth.ts";
import {
  ApiToken,
  cloudflareApi,
  type PickOne,
  placeOf,
  saveToken,
} from "./cloudflare.ts";
import { loadTunnels } from "./tunnel.ts";

const MAX_TOKEN_CHARS = 1024;

const tokenFromStdin = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const out = yield* Output;
  if (yield* stdio.stdinIsTerminal)
    yield* out.note("paste the API token, then press Enter and Ctrl-D");
  const decoder = new TextDecoder();
  const text = yield* Stream.runFold(
    stdio.stdin,
    () => "",
    (read, chunk: Uint8Array) =>
      read.length > MAX_TOKEN_CHARS
        ? read
        : read + decoder.decode(chunk, { stream: true })
  ).pipe(Effect.orElseSucceed(() => ""));
  const token = text.trim();
  if (!Schema.is(ApiToken)(token))
    return yield* new UsageError({
      message: "expected one Cloudflare API token on stdin",
      hint: "pipe it in, for example `devbox hub cloudflare token < token-file`",
    });
  return token;
});

const FLAG: Readonly<Record<PickOne["what"], string>> = {
  account: "--account <id>",
  zone: "--zone <domain>",
};

/** What a command prints when the login does not settle its account or zone. */
const asCommandError = ({ what, choices, named }: PickOne) => {
  const listed = choices
    .map((c) => (what === "account" ? `${c.id} (${c.name})` : c.name))
    .join(", ");
  if (named !== undefined)
    return new UsageError({
      message: `the token sees no ${what} ${named}`,
      hint:
        choices.length === 0
          ? "give the token access to one"
          : `it sees ${listed}`,
    });
  if (choices.length === 0)
    return new CloudflareFailed({
      message: `the token sees no ${what}`,
      hint: `give it access to the ${what} that holds your domain`,
    });
  return new UsageError({
    message: `the token sees ${choices.length} ${what}s: ${listed}`,
    hint: `pass ${FLAG[what]} to pick one`,
  });
};

const tokenCommand = Command.make(
  "token",
  {
    account: Flag.String("account").pipe(
      Flag.withDescription(
        "the Cloudflare account id, when the token sees more than one"
      ),
      Flag.optional
    ),
    zone: Flag.String("zone").pipe(
      Flag.withDescription(
        "the domain to publish machines under, when the token sees more than one"
      ),
      Flag.optional
    ),
  },
  (wanted) =>
    Effect.gen(function* () {
      const out = yield* Output;
      const { home } = yield* Locations;
      const token = yield* tokenFromStdin;
      const saved = yield* saveToken(home, token, wanted).pipe(
        Effect.catchTag("PickOne", (pick) => Effect.fail(asCommandError(pick)))
      );
      yield* out.success(`saved a Cloudflare API token for ${saved.zone}`);
    })
).pipe(
  Command.withDescription(
    "Save a Cloudflare API token, read from stdin, that the hub publishes machines with"
  )
);

/** Saves what an OAuth login hands over, in the account and zone the flags name. */
export const saveLogin = ({ clientId, tokens, account, zone }: SignedIn) =>
  Effect.gen(function* () {
    const { home } = yield* Locations;
    const place = yield* placeOf(cloudflareApi(tokens.accessToken), {
      account,
      zone,
    }).pipe(
      Effect.catchTag("PickOne", (pick) => Effect.fail(asCommandError(pick)))
    );
    yield* saveCloudflare(home, {
      login: { kind: "oauth", clientId, ...tokens },
      ...place,
    });
  });

const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const out = yield* Output;
    const saved = yield* loadCloudflare((yield* Locations).home);
    if (Option.isNone(saved))
      return yield* out.stdout("No Cloudflare login is saved.\n");
    const { login, zone, accountId } = saved.value;
    const kind =
      login.kind === "token" ? "token" : `oauth with client ${login.clientId}`;
    const ends =
      login.kind === "token" ? "" : `, access until ${login.expiresAt}`;
    yield* out.stdout(
      `Cloudflare: ${kind}, zone ${zone}, account ${accountId}${ends}.\n`
    );
  })
).pipe(
  Command.withDescription(
    "Say how the hub signs in to Cloudflare, and for which zone"
  )
);

const logoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    const out = yield* Output;
    const { home } = yield* Locations;
    if (!(yield* forgetCloudflare(home)))
      return yield* out.stdout("No Cloudflare login was saved.\n");
    yield* out.success("forgot the Cloudflare login");
    const published = Object.keys(yield* loadTunnels(home));
    if (published.length > 0)
      yield* out.warn(
        `${published.join(", ")} stay on the internet. Save a login again to unpublish them from the hub`
      );
  })
).pipe(Command.withDescription("Delete the hub's Cloudflare login"));

export const cloudflareCommand = Command.make("cloudflare").pipe(
  Command.withDescription(
    "Manage the Cloudflare login the hub publishes machines with"
  ),
  Command.withSubcommands([
    tokenCommand,
    loginCommand(saveLogin),
    statusCommand,
    logoutCommand,
  ])
);
