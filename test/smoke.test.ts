import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixture } from "./support/fixture.ts";

const buildDir = mkdtempSync(join(tmpdir(), "devbox-build-"));
const binary = join(buildDir, "devbox");

beforeAll(() => {
  const build = Bun.spawnSync(["bun", "build", "src/cli.ts", "--compile", "--outfile", binary]);
  expect(build.exitCode).toBe(0);
}, 60_000);

afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

test("the compiled binary runs a command, prints JSON on stdout and exits with the usage code", () => {
  const f = makeFixture();
  const env = { ...f.env, PATH: process.env.PATH ?? "", NO_COLOR: "1" };
  const doctor = Bun.spawnSync([binary, "migrate", "doctor", "--db", f.db, "--json"], {
    env,
    stdin: "ignore",
  });
  expect(doctor.exitCode).toBe(0);
  expect(JSON.parse(doctor.stdout.toString()).schema).toEqual({ ok: true, missing: [] });
  expect(doctor.stderr.toString()).toContain("devbox 0.1.0");
  const bogus = Bun.spawnSync([binary, "migrate", "bogus"], { env, stdin: "ignore" });
  expect(bogus.exitCode).toBe(2);
  expect(bogus.stdout.toString()).toBe("");
  expect(bogus.stderr.toString()).toContain('Error: Unknown subcommand "bogus"');
});
