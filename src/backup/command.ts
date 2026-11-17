import { Command } from "effect/cli";
import { listSources, runBackup, verifyBackup } from "./run.ts";

const run = Command.make("run", {}, () => runBackup).pipe(
  Command.withDescription(
    "Snapshot every SQLite file, then back up the sources to the restic repository and prune old snapshots",
  ),
);

const verify = Command.make("verify", {}, () => verifyBackup).pipe(
  Command.withDescription(
    "Check the repository, restore the latest SQLite snapshots to a temporary folder and open each one",
  ),
);

const sources = Command.make("sources", {}, () => listSources).pipe(
  Command.withDescription(
    "Print the sources that exist on this machine, one `name<TAB>path` per line",
  ),
);

export const backup = Command.make("backup").pipe(
  Command.withSubcommands([run, verify, sources]),
  Command.withDescription(
    "Back up agent memory and threads to a restic repository. Config lives in ~/.config/devbox/backup.",
  ),
);
