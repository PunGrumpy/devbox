import { Effect, FileSystem, Option, Schema } from "effect";
import { dirname, join } from "node:path";
import type { Host } from "../machine/host.ts";
import type { Fields } from "../spoke/signed.ts";
import { type CloudflareAccount, loadCloudflare } from "./cloudflare-auth.ts";
import {
  type CloudflareApi,
  type CloudflareRefused,
  type DnsRecord,
  type NewRule,
} from "./cloudflare.ts";
import { json, type Reply, refuse } from "./login.ts";
import { type Machine, origin } from "./machines.ts";

/** The machine name in lower case, with anything outside a-z and 0-9 turned into a dash. */
export const slugOf = (name: string): string => name.toLowerCase().replaceAll(/[^a-z0-9]/g, "-");

export const hostnameOf = (name: string, zone: string): string => `t3-${slugOf(name)}.${zone}`;

const DNS_LABEL_UP_TO_63 = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const ONE_DNS_LABEL = new RegExp(`^${DNS_LABEL_UP_TO_63}$`);
const ZONE = new RegExp(`^(?:${DNS_LABEL_UP_TO_63}\\.)+[a-z0-9-]{2,63}$`);

const hostable = (name: string, zone: string): boolean =>
  ONE_DNS_LABEL.test(`t3-${slugOf(name)}`) && ZONE.test(zone);

/** The WAF expression the README gives, which blocks T3's MCP paths on the hostname. */
export const expressionFor = (hostname: string): string =>
  `(http.host eq "${hostname}" and (starts_with(lower(http.request.uri.path), "/mcp") or starts_with(lower(http.request.uri.path), "/oauth/mcp")))`;

/**
 * How devbox tells what it made from what the owner made: a rule by its `ref`, a tunnel by its
 * name, a DNS record by its comment or by pointing at devbox's tunnel. Nothing else is ever
 * changed or deleted.
 */
export const ruleRef = (name: string) => `devbox-t3-${slugOf(name)}`;
export const tunnelName = (name: string) => `devbox-${slugOf(name)}`;
export const RECORD_COMMENT = "made by devbox for T3 Code";

export const TUNNEL_MS = 120_000;

const Made = Schema.Struct({
  hostname: Schema.String,
  accountId: Schema.String,
  zoneId: Schema.String,
  /** Whether every step was done and the spoke took the token, so the hostname answers. */
  published: Schema.Boolean,
});
export type Made = typeof Made.Type;

const Tunnels = Schema.fromJsonString(Schema.Record(Schema.String, Made));
export type Tunnels = Readonly<Record<string, Made>>;

export const tunnelsFile = (home: string) =>
  join(home, ".local", "state", "devbox", "tunnels.json");

/** What the hub made, by machine name. A file that does not parse holds nothing. */
export const loadTunnels = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(tunnelsFile(home)).pipe(Effect.option);
    return Option.getOrElse(
      Option.flatMap(text, (t) => Schema.decodeUnknownOption(Tunnels)(t)),
      (): Tunnels => ({}),
    );
  });

const remember = (home: string, name: string, made: Made | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = tunnelsFile(home);
    const { [name]: _, ...others } = yield* loadTunnels(home);
    const next = made === undefined ? others : { ...others, [name]: made };
    yield* fs.makeDirectory(dirname(path), { recursive: true });
    yield* fs.writeFileString(`${path}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
    yield* fs.rename(`${path}.tmp`, path);
  }).pipe(Effect.orDie);

/** The tunnel's address for the snapshot, once it answers. */
export const tunnelOf = (tunnels: Tunnels, name: string): { readonly url: string } | null => {
  const made = Object.hasOwn(tunnels, name) ? tunnels[name] : undefined;
  return made?.published === true ? { url: `https://${made.hostname}` } : null;
};

export type Step =
  | "sign in to Cloudflare"
  | "check the hostname"
  | "add the WAF rule"
  | "create the tunnel"
  | "route the tunnel"
  | "point DNS at the tunnel"
  | "get the tunnel token"
  | "hand the tunnel to the machine"
  | "take the tunnel from the machine"
  | "delete the DNS record"
  | "delete the tunnel"
  | "delete the WAF rule";

/** A step that did not happen, and what Cloudflare or the machine said. Never a secret. */
export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  step: Schema.String,
  said: Schema.String,
}) {}

const at =
  (step: Step) =>
  <A, R>(effect: Effect.Effect<A, CloudflareRefused, R>) =>
    Effect.mapError(effect, (error) => new StepFailed({ step, said: error.said }));

/** What a tunnel job needs: the machine, a way to Cloudflare, and a way to its spoke. */
export type TunnelJob = {
  readonly home: string;
  readonly machine: Pick<Machine, "name" | "tailscale">;
  /** The names of the hub's other machines, none of which may make the same hostname. */
  readonly others: ReadonlyArray<string>;
  readonly t3Port: number;
  readonly cloudflare: (
    account: CloudflareAccount,
  ) => Effect.Effect<CloudflareApi, StepFailed, FileSystem.FileSystem>;
  /** Sends a signed request to the machine's spoke, true when it took it. */
  readonly tell: (
    action: "tunnel" | "untunnel",
    fields: Fields,
  ) => Effect.Effect<boolean, never, Host>;
};

export const NO_LOGIN = refuse(
  409,
  "The hub has no Cloudflare login. Connect one under Settings on the hub page, or run devbox hub cloudflare token.",
);

const asReply = (name: string, doing: string) => (error: StepFailed) =>
  json(502, {
    error: `${doing} ${name} stopped when devbox tried to ${error.step}: ${error.said}`,
    step: error.step,
  });

const tunnelsNamed = <T extends { readonly name: string; readonly config_src?: string | null }>(
  found: ReadonlyArray<T>,
  name: string,
): ReadonlyArray<T> =>
  found.filter((t) => t.name === name && (t.config_src ?? "cloudflare") === "cloudflare");

const foreign = (hostname: string) =>
  refuse(409, `${hostname} already has a DNS record that devbox did not make.`);

const ours = (record: DnsRecord, targets: ReadonlyArray<string>) =>
  record.comment === RECORD_COMMENT ||
  (record.type === "CNAME" && targets.includes(record.content ?? ""));

/**
 * Puts T3 Code on the machine on the internet. Every step first looks for what an earlier run
 * made, so a publish that stopped half way is asked again. The WAF rule comes first, so the
 * hostname never answers without it.
 */
export const publish = (job: TunnelJob) =>
  Effect.gen(function* () {
    const { home, machine } = job;
    const { name } = machine;
    const saved = yield* loadCloudflare(home);
    if (Option.isNone(saved)) return NO_LOGIN;
    const account = saved.value;
    const ip = machine.tailscale?.ip ?? "";
    if (ip === "") return refuse(409, `${name} has no Tailscale address to send the tunnel to.`);
    if (!hostable(name, account.zone))
      return refuse(409, `devbox cannot make a hostname in ${account.zone} from the name ${name}.`);
    const hostname = hostnameOf(name, account.zone);
    const tunnels = yield* loadTunnels(home);
    const sharing = [
      ...Object.keys(tunnels).filter((other) => tunnels[other]?.hostname === hostname),
      ...job.others.filter((other) => hostnameOf(other, account.zone) === hostname),
    ].find((other) => other !== name);
    if (sharing !== undefined)
      return refuse(409, `${name} and ${sharing} would share ${hostname}. Rename one of them.`);
    const before = Object.hasOwn(tunnels, name) ? tunnels[name] : undefined;
    if (before !== undefined && before.zoneId !== account.zoneId)
      return refuse(409, `${name} is published in another zone. Unpublish it first.`);
    const api = yield* job.cloudflare(account);
    const { accountId, zoneId } = account;
    const made: Made = { hostname, accountId, zoneId, published: before?.published ?? false };
    const url = `https://${hostname}`;

    const existing = yield* at("check the hostname")(api.findRecords(zoneId, hostname));
    const named = tunnelsNamed(
      yield* at("create the tunnel")(api.findTunnels(accountId, tunnelName(name))),
      tunnelName(name),
    );
    const targets = named.map((t) => `${t.id}.cfargotunnel.com`);
    if (existing.some((r) => !ours(r, targets))) return foreign(hostname);
    yield* remember(home, name, made);

    const rule: NewRule = {
      ref: ruleRef(name),
      description: `devbox: no MCP on ${hostname}`,
      expression: expressionFor(hostname),
    };
    yield* at("add the WAF rule")(
      Effect.gen(function* () {
        const firewall = yield* api.firewall(zoneId);
        if (Option.isNone(firewall)) return yield* api.createFirewall(zoneId, rule);
        if ((firewall.value.rules ?? []).some((r) => r.ref === rule.ref)) return firewall.value;
        return yield* api.addRule(zoneId, firewall.value.id, rule);
      }),
    );

    const tunnel =
      named[0] ?? (yield* at("create the tunnel")(api.createTunnel(accountId, tunnelName(name))));
    yield* at("route the tunnel")(
      api.putIngress(accountId, tunnel.id, hostname, origin(ip, job.t3Port)),
    );

    const target = `${tunnel.id}.cfargotunnel.com`;
    const records = yield* at("point DNS at the tunnel")(api.findRecords(zoneId, hostname));
    if (records.some((r) => !ours(r, [target]))) return foreign(hostname);
    const [record] = records;
    if (record === undefined)
      yield* at("point DNS at the tunnel")(
        api.createRecord(zoneId, { name: hostname, content: target, comment: RECORD_COMMENT }),
      );
    else if (record.type !== "CNAME" || record.content !== target)
      yield* at("point DNS at the tunnel")(api.editRecord(zoneId, record.id, target));

    const token = yield* at("get the tunnel token")(api.tunnelToken(accountId, tunnel.id));
    if (!(yield* job.tell("tunnel", { token, url })))
      return yield* new StepFailed({
        step: "hand the tunnel to the machine",
        said: `${name} did not take it`,
      });
    yield* remember(home, name, { ...made, published: true });
    return json(202, { url });
  }).pipe(
    Effect.catchTag("StepFailed", (error) =>
      Effect.succeed(asReply(job.machine.name, "Publishing")(error)),
    ),
  );

/**
 * Takes the machine off the internet: the spoke stops its tunnel, then the hub deletes the DNS
 * record, the tunnel and the WAF rule, in that order, so the rule outlives the hostname.
 */
export const unpublish = (job: TunnelJob) =>
  Effect.gen(function* () {
    const { home, machine } = job;
    const { name } = machine;
    const saved = yield* loadCloudflare(home);
    if (Option.isNone(saved)) return NO_LOGIN;
    if ((machine.tailscale?.ip ?? "") === "")
      return refuse(409, `${name} has no Tailscale address to take the tunnel from.`);
    const tunnels = yield* loadTunnels(home);
    const before = Object.hasOwn(tunnels, name) ? tunnels[name] : undefined;
    const account = saved.value;
    const accountId = before?.accountId ?? account.accountId;
    const zoneId = before?.zoneId ?? account.zoneId;
    const hostname = before?.hostname ?? hostnameOf(name, account.zone);
    const api = yield* job.cloudflare(account);

    if (!(yield* job.tell("untunnel", {})))
      return yield* new StepFailed({
        step: "take the tunnel from the machine",
        said: `${name} did not take it`,
      });
    if (before !== undefined) yield* remember(home, name, { ...before, published: false });

    const named = tunnelsNamed(
      yield* at("delete the tunnel")(api.findTunnels(accountId, tunnelName(name))),
      tunnelName(name),
    );
    const targets = named.map((t) => `${t.id}.cfargotunnel.com`);
    const records = yield* at("delete the DNS record")(api.findRecords(zoneId, hostname));
    yield* at("delete the DNS record")(
      Effect.forEach(
        records.filter((r) => ours(r, targets)),
        (r) => api.deleteRecord(zoneId, r.id),
        { discard: true },
      ),
    );
    yield* at("delete the tunnel")(
      Effect.forEach(named, (t) => api.deleteTunnel(accountId, t.id), { discard: true }),
    );
    yield* at("delete the WAF rule")(
      Effect.gen(function* () {
        const firewall = yield* api.firewall(zoneId);
        if (Option.isNone(firewall)) return;
        const rules = (firewall.value.rules ?? []).filter((r) => r.ref === ruleRef(name));
        yield* Effect.forEach(rules, (r) => api.deleteRule(zoneId, firewall.value.id, r.id), {
          discard: true,
        });
      }),
    );
    yield* remember(home, name, undefined);
    return { status: 204, headers: { "cache-control": "no-store" }, body: "" } satisfies Reply;
  }).pipe(
    Effect.catchTag("StepFailed", (error) =>
      Effect.succeed(asReply(job.machine.name, "Unpublishing")(error)),
    ),
  );
