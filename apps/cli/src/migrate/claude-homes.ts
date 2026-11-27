import { join } from "node:path";

import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";

import { Locations } from "./locations.ts";
import { absolutePath } from "./paths.ts";
import type { AbsolutePath } from "./paths.ts";

export type ClaudeHome = {
  readonly instances: readonly string[];
  readonly enabled: boolean;
  readonly path: AbsolutePath;
};

export class SettingsUnreadable extends Schema.TaggedError<SettingsUnreadable>()(
  "SettingsUnreadable",
  {
    file: Schema.String,
    reason: Schema.String,
  }
) {
  override get message() {
    return `cannot read ${this.file}: ${this.reason}`;
  }
  get hint() {
    return "fix it first; nothing was changed. The Claude homes come from this file";
  }
}

export const CLAUDE_DRIVER = "claudeAgent";

const Settings = Schema.fromJsonString(
  Schema.Struct({
    providerInstances: Schema.optional(
      Schema.Record(Schema.String, Schema.Unknown)
    ),
  })
);

const ClaudeInstance = Schema.Struct({
  driver: Schema.Literal(CLAUDE_DRIVER),
  enabled: Schema.optional(Schema.Unknown),
  config: Schema.optional(Schema.Unknown),
});

export class ClaudeHomes extends Context.Service<
  ClaudeHomes,
  {
    readonly list: Effect.Effect<readonly ClaudeHome[], SettingsUnreadable>;
    readonly defaultHome: AbsolutePath;
    readonly configDirElsewhere: Option.Option<AbsolutePath>;
  }
>()("devbox/migrate/ClaudeHomes") {
  static readonly layer = (override: Option.Option<string>) =>
    Layer.effect(
      ClaudeHomes,
      Effect.gen(function* () {
        const { home, settingsFile, claudeConfigDir } = yield* Locations;
        const fs = yield* FileSystem.FileSystem;

        const defaultHome = Option.match(override, {
          onNone: () => absolutePath(join(home, ".claude")),
          onSome: (path) => absolutePath(path),
        });

        const expandHome = (value: string) => {
          if (value === "~") {
            return home;
          }

          if (/^~[\\/]/.test(value)) {
            return join(home, value.slice(2));
          }

          return value;
        };

        const realOrSelf = (path: AbsolutePath) =>
          fs.realPath(path).pipe(Effect.orElseSucceed(() => path));

        const list = Effect.gen(function* () {
          if (
            !(yield* fs
              .exists(settingsFile)
              .pipe(Effect.orElseSucceed(() => false)))
          ) {
            return [];
          }

          const settings = yield* fs.readFileString(settingsFile).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Settings)),
            Effect.mapError(
              (error) =>
                new SettingsUnreadable({
                  file: settingsFile,
                  reason: error.message,
                })
            )
          );

          const homes = new Map<
            string,
            { instances: string[]; enabled: boolean; path: AbsolutePath }
          >();

          for (const [id, raw] of Object.entries(
            settings.providerInstances ?? {}
          )) {
            const instance = Schema.decodeUnknownOption(ClaudeInstance)(raw);

            if (Option.isNone(instance)) {
              continue;
            }

            const { config, enabled } = instance.value;

            const configured =
              Predicate.hasProperty(config, "homePath") &&
              Predicate.isString(config.homePath)
                ? config.homePath.trim()
                : "";

            const path = configured
              ? absolutePath(expandHome(configured))
              : defaultHome;

            const key = yield* realOrSelf(path);
            const known = homes.get(key);

            if (known) {
              known.instances.push(id);
              known.enabled ||= enabled !== false;
            } else {
              homes.set(key, {
                instances: [id],
                enabled: enabled !== false,
                path,
              });
            }
          }

          return [...homes.values()];
        });

        return {
          list,
          defaultHome,
          configDirElsewhere: Option.filter(
            claudeConfigDir,
            (dir) => dir !== defaultHome
          ),
        };
      })
    );
}
