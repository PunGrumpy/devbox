import { Argument, Command, Flag } from "effect/cli";

import { listSources, restoreBackup, runBackup, verifyBackup } from "./run.ts";

const run = Command.make("run", {}, () => runBackup).pipe(
  Command.withDescription(
    "Snapshot every SQLite file, then back up the sources to the restic repository and prune old snapshots"
  )
);

const verify = Command.make("verify", {}, () => verifyBackup).pipe(
  Command.withDescription(
    "Check the repository, restore the latest SQLite snapshots to a temporary folder and open each one"
  )
);

const restore = Command.make(
  "restore",
  {
    target: Argument.String("target-dir").pipe(
      Argument.withDescription("folder to restore into, outside the live paths")
    ),
    snapshot: Flag.String("snapshot").pipe(
      Flag.withDescription("restic snapshot id"),
      Flag.withDefault("latest")
    ),
  },
  ({ target, snapshot }) => restoreBackup(target, snapshot)
).pipe(
  Command.withDescription(
    "Restore a snapshot of this machine into a folder, with each SQLite snapshot back at its live path inside it"
  )
);

const sources = Command.make("sources", {}, () => listSources).pipe(
  Command.withDescription(
    "Print the sources that exist on this machine, one `name<TAB>path` per line"
  )
);

export const backup = Command.make("backup").pipe(
  Command.withSubcommands([run, verify, restore, sources]),
  Command.withDescription(
    "Back up agent memory and threads to a restic repository. Config lives in ~/.config/devbox/backup."
  )
);
