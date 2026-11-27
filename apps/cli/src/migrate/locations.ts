import { homedir } from "node:os";
import path from "node:path";

import { Config, Context, Effect, Layer, Option } from "effect";

import { absolutePath } from "./paths.ts";
import type { AbsolutePath } from "./paths.ts";

const env = (name: string) => Config.option(Config.String(name));

export class Locations extends Context.Service<
  Locations,
  {
    readonly home: AbsolutePath;
    readonly liveDb: AbsolutePath;
    readonly runtimeFile: AbsolutePath;
    readonly settingsFile: AbsolutePath;
    readonly backupDir: AbsolutePath;
    readonly claudeConfigDir: Option.Option<AbsolutePath>;
  }
>()("devbox/migrate/Locations") {
  static readonly layer = Layer.effect(
    Locations,
    Effect.gen(function* () {
      const home = absolutePath(Option.getOrElse(yield* env("HOME"), homedir));

      const t3Home = absolutePath(
        Option.getOrElse(yield* env("T3_HOME"), () => path.join(home, ".t3"))
      );

      const backupDir = Option.getOrElse(yield* env("T3_BACKUP_DIR"), () =>
        path.join(t3Home, "backups")
      );

      return {
        home,
        liveDb: absolutePath(path.join(t3Home, "userdata", "statev2.sqlite")),
        runtimeFile: absolutePath(
          path.join(t3Home, "userdata", "server-runtime.json")
        ),
        settingsFile: absolutePath(
          path.join(t3Home, "userdata", "settings.json")
        ),
        backupDir: absolutePath(backupDir),
        claudeConfigDir: Option.map(yield* env("CLAUDE_CONFIG_DIR"), (dir) =>
          absolutePath(dir)
        ),
      };
    }).pipe(Effect.orDie)
  );
}
