// The CLI moved to apps/cli. A wrapper or a systemd unit written before the move still runs this
// path, so it hands over to the new one until `install.sh` or `devbox up` rewrites them.
import { fileURLToPath } from "node:url";

const moved = fileURLToPath(new URL("../apps/cli/src/cli.ts", import.meta.url));
const child = Bun.spawnSync([process.execPath, moved, ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(child.exitCode);
