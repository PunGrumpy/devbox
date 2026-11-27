import { Effect, FileSystem, Option, Stdio, Stream } from "effect";
import { Command, Flag } from "effect/cli";
import { UsageError } from "../errors.ts";
import { Locations } from "../migrate/locations.ts";
import { Output } from "../output.ts";
import {
  CloudflareFailed,
  cloudflareFile,
  loadCloudflare,
  saveCloudflare,
} from "./cloudflare-auth.ts";
import { loginCommand, type SignedIn } from "./cloudflare-oauth.ts";
import { type CloudflareApi, cloudflareApi, failed, type Named } from "./cloudflare.ts";
import { loadTunnels } from "./tunnel.ts";

const MAX_TOKEN_CHARS = 1024;
const TOKEN = /^[\x21-\x7e]{1,1024}$/;

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
      read.length > MAX_TOKEN_CHARS ? read : read + decoder.decode(chunk, { stream: true }),
  ).pipe(Effect.orElseSucceed(() => ""));
  const token = text.trim();
  if (!TOKEN.test(token))
    return yield* new UsageError({
      message: "expected one Cloudflare API token on stdin",
      hint: "pipe it in, for example `devbox hub cloudflare token < token-file`",
    });
  return token;
});

const choose = <A extends Named>(
  what: string,
  flag: string,
  choices: ReadonlyArray<A>,
  wanted: Option.Option<string>,
  matches: (choice: A, wanted: string) => boolean,
  label: (choice: A) => string,
) =>
  Effect.gen(function* () {
    const listed = choices.map(label).join(", ");
    if (Option.isSome(wanted)) {
      const found = choices.find((c) => matches(c, wanted.value));
      if (found !== undefined) return found;
      return yield* new UsageError({
        message: `the token sees no ${what} ${wanted.value}`,
        hint: choices.length === 0 ? `give the token access to one` : `it sees ${listed}`,
      });
    }
    const [only, ...others] = choices;
    if (only !== undefined && others.length === 0) return only;
    if (only === undefined)
      return yield* new CloudflareFailed({
        message: `the token sees no ${what}`,
        hint: `give it access to the ${what} that holds your domain`,
      });
    return yield* new UsageError({
      message: `the token sees ${choices.length} ${what}s: ${listed}`,
      hint: `pass ${flag} to pick one`,
    });
  });

const placeOf = (
  api: CloudflareApi,
  wanted: { readonly account: Option.Option<string>; readonly zone: Option.Option<string> },
) =>
  Effect.gen(function* () {
    const accounts = yield* api.accounts.pipe(
      Effect.mapError(failed("list the accounts this token sees")),
    );
    const account = yield* choose(
      "account",
      "--account <id>",
      accounts,
      wanted.account,
      (a, id) => a.id === id,
      (a) => `${a.id} (${a.name})`,
    );
    const zones = yield* api
      .zones(account.id)
      .pipe(Effect.mapError(failed("list the zones this token sees")));
    const zone = yield* choose(
      "zone",
      "--zone <domain>",
      zones,
      wanted.zone,
      (z, name) => z.name.toLowerCase() === name.toLowerCase(),
      (z) => z.name,
    );
    return { accountId: account.id, zoneId: zone.id, zone: zone.name.toLowerCase() };
  });

const tokenCommand = Command.make(
  "token",
  {
    account: Flag.String("account").pipe(
      Flag.withDescription("the Cloudflare account id, when the token sees more than one"),
      Flag.optional,
    ),
    zone: Flag.String("zone").pipe(
      Flag.withDescription(
        "the domain to publish machines under, when the token sees more than one",
      ),
      Flag.optional,
    ),
  },
  (wanted) =>
    Effect.gen(function* () {
      const out = yield* Output;
      const { home } = yield* Locations;
      const token = yield* tokenFromStdin;
      const api = cloudflareApi(token);
      const place = yield* placeOf(api, wanted);
      const verified = yield* api
        .verify(place.accountId)
        .pipe(Effect.mapError(failed("verify the token")));
      if (verified.status !== "active")
        return yield* new CloudflareFailed({
          message: `Cloudflare says the token is ${verified.status}`,
          hint: "make a new one in the Cloudflare dashboard",
        });
      yield* saveCloudflare(home, { login: { kind: "token", token }, ...place });
      yield* out.success(`saved a Cloudflare API token for ${place.zone}`);
    }),
).pipe(
  Command.withDescription(
    "Save a Cloudflare API token, read from stdin, that the hub publishes machines with",
  ),
);

/** Saves what an OAuth login hands over, in the account and zone the flags name. */
export const saveLogin = ({ clientId, tokens, account, zone }: SignedIn) =>
  Effect.gen(function* () {
    const { home } = yield* Locations;
    const place = yield* placeOf(cloudflareApi(tokens.accessToken), { account, zone });
    yield* saveCloudflare(home, { login: { kind: "oauth", clientId, ...tokens }, ...place });
  });

const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const out = yield* Output;
    const saved = yield* loadCloudflare((yield* Locations).home);
    if (Option.isNone(saved)) return yield* out.stdout("No Cloudflare login is saved.\n");
    const { login, zone, accountId } = saved.value;
    const kind = login.kind === "token" ? "token" : `oauth with client ${login.clientId}`;
    const ends = login.kind === "token" ? "" : `, access until ${login.expiresAt}`;
    yield* out.stdout(`Cloudflare: ${kind}, zone ${zone}, account ${accountId}${ends}.\n`);
  }),
).pipe(Command.withDescription("Say how the hub signs in to Cloudflare, and for which zone"));

const logoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    const out = yield* Output;
    const fs = yield* FileSystem.FileSystem;
    const { home } = yield* Locations;
    const path = cloudflareFile(home);
    if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))))
      return yield* out.stdout("No Cloudflare login was saved.\n");
    yield* fs
      .remove(path)
      .pipe(Effect.mapError(() => new CloudflareFailed({ message: `cannot delete ${path}` })));
    yield* out.success("forgot the Cloudflare login");
    const published = Object.keys(yield* loadTunnels(home));
    if (published.length > 0)
      yield* out.warn(
        `${published.join(", ")} stay on the internet. Save a login again to unpublish them from the hub`,
      );
  }),
).pipe(Command.withDescription("Delete the hub's Cloudflare login"));

export const cloudflareCommand = Command.make("cloudflare").pipe(
  Command.withDescription("Manage the Cloudflare login the hub publishes machines with"),
  Command.withSubcommands([tokenCommand, loginCommand(saveLogin), statusCommand, logoutCommand]),
);
