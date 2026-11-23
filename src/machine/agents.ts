import { Data, Effect, FileSystem, Option, Result, Schema } from "effect";
import { join } from "node:path";
import { type Aborted, UsageError } from "../errors.ts";
import { Output } from "../output.ts";
import { Host, type Ran } from "./host.ts";
import { processEnv, settingsFor } from "./settings.ts";

/** How an agent gets onto the machine without sudo. It also says who keeps it current. */
export type Install = Data.TaggedEnum<{
  /** `curl -fsSL url | bash` with HOME=<data>. `update` is the argv `serve` runs at each start; none means the agent updates itself. */
  Script: { readonly url: string; readonly update: Option.Option<ReadonlyArray<string>> };
  /** `npm install -g --prefix <data>/.local <pkg>@latest`, run again by `serve` at each start. */
  Npm: { readonly pkg: string };
}>;
export const Install = Data.taggedEnum<Install>();

type Agent = {
  readonly id: string;
  readonly name: string;
  readonly bin: string;
  readonly install: Install;
  /** The `npx skills --agent` name. Undefined means the agent takes no skills. */
  readonly skills: string | undefined;
  readonly login: string;
  readonly byDefault: boolean;
};

/** The one list of agents. Its order is the display order and the order of agents.json. */
export const AGENTS = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    install: Install.Script({ url: "https://claude.ai/install.sh", update: Option.none() }),
    skills: "claude-code",
    login: "claude auth login",
    byDefault: true,
  },
  {
    id: "codex",
    name: "Codex",
    bin: "codex",
    install: Install.Npm({ pkg: "@openai/codex" }),
    skills: "codex",
    login: "codex login --device-auth",
    byDefault: true,
  },
  {
    id: "devin",
    name: "Devin",
    bin: "devin",
    install: Install.Script({
      url: "https://cli.devin.ai/install.sh",
      update: Option.some(["devin", "update"]),
    }),
    skills: "devin",
    login: "devin configure",
    byDefault: false,
  },
  {
    id: "opencode",
    name: "OpenCode",
    bin: "opencode",
    install: Install.Npm({ pkg: "opencode-ai" }),
    skills: "opencode",
    login: "opencode auth login",
    byDefault: false,
  },
] as const satisfies ReadonlyArray<Agent>;

export type AgentId = (typeof AGENTS)[number]["id"];

const agentOf = (id: AgentId): Agent => AGENTS.find((agent) => agent.id === id)!;
const isAgentId = (word: string): word is AgentId => AGENTS.some((agent) => agent.id === word);
const KNOWN = AGENTS.map((agent) => agent.id).join(", ");

/** Unique and in AGENTS order, so two lists that mean the same set serialize the same. Only `normalize` builds one. */
export type AgentIds = ReadonlyArray<AgentId> & { readonly AgentIds: unique symbol };
export const normalize = (ids: Iterable<AgentId>): AgentIds => {
  const wanted = new Set(ids);
  return AGENTS.map((agent) => agent.id).filter((id) => wanted.has(id)) as unknown as AgentIds;
};

export const DEFAULT_AGENTS = normalize(
  AGENTS.filter((agent) => agent.byDefault).map((agent) => agent.id),
);

export type AgentsFlag = Data.TaggedEnum<{ Pick: {}; Set: { readonly ids: AgentIds } }>;
export const AgentsFlag = Data.taggedEnum<AgentsFlag>();

/** `--agents`: `pick`, `none`, or a comma list of ids. The failure names the bad word. */
export const parseAgentsFlag = (text: string): Result.Result<AgentsFlag, string> => {
  if (text.trim() === "pick") return Result.succeed(AgentsFlag.Pick());
  if (text.trim() === "none") return Result.succeed(AgentsFlag.Set({ ids: normalize([]) }));
  const words = text.split(",").map((word) => word.trim());
  const bad = words.find((word) => !isAgentId(word));
  if (bad !== undefined)
    return Result.fail(
      bad === ""
        ? `empty agent name in "${text}"; known: ${KNOWN}`
        : `unknown agent "${bad}"; known: ${KNOWN}`,
    );
  return Result.succeed(AgentsFlag.Set({ ids: normalize(words.filter(isAgentId)) }));
};

export type AgentChoice = {
  readonly ids: AgentIds;
  readonly from: "flag" | "picked" | "saved" | "default";
};

/** A person made the choice, so it is saved. Defaults used for lack of a terminal are not. */
export const remembered = (choice: AgentChoice): boolean =>
  choice.from === "flag" || choice.from === "picked";

export const agentsFile = (data: string) => join(data, ".config", "devbox", "agents.json");
export const agentBin = (data: string, id: AgentId) => join(data, ".local", "bin", agentOf(id).bin);

const SavedFile = Schema.fromJsonString(Schema.Struct({ agents: Schema.Array(Schema.String) }));

export const agentsJson = (ids: AgentIds): string =>
  `${JSON.stringify({ agents: ids }, null, 2)}\n`;

/** Ids that AGENTS no longer lists are dropped with a warning, and a file that does not decode counts as absent. */
export const readSavedAgents = (data: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const out = yield* Output;
    const path = agentsFile(data);
    const text = yield* fs.readFileString(path).pipe(Effect.option);
    if (Option.isNone(text)) return Option.none<AgentIds>();
    const decoded = Schema.decodeUnknownOption(SavedFile)(text.value);
    if (Option.isNone(decoded)) {
      yield* out.warn(`${path} is not {"agents": [...]}, ignoring it`);
      return Option.none<AgentIds>();
    }
    const unknown = decoded.value.agents.filter((word) => !isAgentId(word));
    if (unknown.length > 0)
      yield* out.warn(
        `${path} names agents this devbox does not know, ignoring ${unknown.join(", ")}`,
      );
    return Option.some(normalize(decoded.value.agents.filter(isAgentId)));
  });

/** Saved, else the defaults. `serve` uses this; it never asks. */
export const currentAgents = (data: string) =>
  Effect.map(
    readSavedAgents(data),
    Option.getOrElse(() => DEFAULT_AGENTS),
  );

const pickAgents = (ticked: AgentIds) =>
  Effect.gen(function* () {
    const out = yield* Output;
    const chosen = yield* out.pick(
      "Which agent CLIs should this machine have?",
      AGENTS.map((agent) => ({
        title: agent.name,
        value: agent.id as AgentId,
        selected: ticked.includes(agent.id),
      })),
    );
    return normalize(chosen);
  }).pipe(
    Effect.catchTag("NotATerminal", () =>
      Effect.fail(
        new UsageError({
          message: "--agents pick needs a terminal",
          hint: "name them instead, for example --agents claude,codex",
        }),
      ),
    ),
  );

/** The flag wins, then the saved list. With neither, a terminal gets the picker and no terminal gets the defaults. */
export const chooseAgents = (
  flag: Option.Option<AgentsFlag>,
  saved: Option.Option<AgentIds>,
): Effect.Effect<AgentChoice, UsageError | Aborted, Output> =>
  Effect.gen(function* () {
    const ticked = Option.getOrElse(saved, () => DEFAULT_AGENTS);
    if (Option.isSome(flag)) {
      if (flag.value._tag === "Set") return { ids: flag.value.ids, from: "flag" as const };
      return { ids: yield* pickAgents(ticked), from: "picked" as const };
    }
    if (Option.isSome(saved)) return { ids: saved.value, from: "saved" as const };
    return yield* pickAgents(ticked).pipe(
      Effect.map((ids) => ({ ids, from: "picked" as const })),
      Effect.catchTag("UsageError", () =>
        Effect.succeed({ ids: ticked, from: "default" as const }),
      ),
    );
  });

export const presentAgents = (data: string) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const fs = yield* FileSystem.FileSystem;
    return new Map(
      yield* Effect.forEach(AGENTS, ({ id, bin }) =>
        Effect.gen(function* () {
          const installed = yield* fs
            .exists(agentBin(data, id))
            .pipe(Effect.orElseSucceed(() => false));
          return [id, installed || (yield* host.which(bin))] as const;
        }),
      ),
    );
  });

const FIVE_MINUTES = 300_000;

/** Installs into `<data>/.local`. A Script installer runs with HOME=<data>, detached from any terminal, because Devin's starts a login. */
export const installAgent = (
  id: AgentId,
  data: string,
  npm: string,
): Effect.Effect<Ran, never, Host> =>
  Effect.gen(function* () {
    const host = yield* Host;
    const env = processEnv(settingsFor(data), process.env.PATH ?? "");
    return yield* Install.$match(agentOf(id).install, {
      Npm: ({ pkg }) =>
        host.run([npm, "install", "-g", "--prefix", join(data, ".local"), `${pkg}@latest`], {
          env,
        }),
      Script: ({ url }) =>
        Effect.gen(function* () {
          const script = yield* host.run(["curl", "-fsSL", url]);
          if (script.code !== 0) return script;
          const detach = (yield* host.which("setsid")) ? ["setsid"] : [];
          return yield* host.run([...detach, "bash"], {
            stdin: script.stdout,
            env: { ...env, HOME: data },
            timeoutMs: FIVE_MINUTES,
          });
        }),
    });
  });

/** Best effort and never fails. Npm agents reinstall `@latest`, a Script with an update argv runs it, and the rest update themselves. */
export const updateAgents = (data: string, ids: AgentIds, npm: string) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const out = yield* Output;
    const present = yield* presentAgents(data);
    const env = processEnv(settingsFor(data), process.env.PATH ?? "");
    for (const id of ids) {
      const { name, install } = agentOf(id);
      if (!present.get(id)) {
        yield* out.warn(`agents: ${name} is chosen but not installed, run \`devbox up\``);
        continue;
      }
      const argv = Install.$match(install, {
        Npm: ({ pkg }) =>
          Option.some([npm, "install", "-g", "--prefix", join(data, ".local"), `${pkg}@latest`]),
        Script: ({ update }) => update,
      });
      if (Option.isNone(argv)) continue;
      const ran = yield* host.run(argv.value, { env, timeoutMs: FIVE_MINUTES });
      yield* ran.code === 0
        ? out.log(`agents: ${name} is current`)
        : out.warn(`agents: ${name} did not update, exit ${ran.code}`);
    }
  });

export const skillsAgentsOf = (ids: AgentIds): ReadonlyArray<string> =>
  ids.flatMap((id) => agentOf(id).skills ?? []);

export const loginHint = (id: AgentId): string => agentOf(id).login;

export const removeHint = (id: AgentId, data: string): string =>
  Install.$match(agentOf(id).install, {
    Npm: ({ pkg }) => `\`npm rm -g --prefix ${join(data, ".local")} ${pkg}\` removes it`,
    Script: () => `delete ${agentBin(data, id)} to remove it`,
  });

export const agentName = (id: AgentId): string => agentOf(id).name;

export class AgentInstallFailed extends Schema.TaggedError<AgentInstallFailed>()(
  "AgentInstallFailed",
  { id: Schema.String, code: Schema.Number, detail: Schema.String },
) {
  override get message() {
    return `${this.id} did not install, exit ${this.code}`;
  }
}
