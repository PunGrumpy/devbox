import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: ["dist", "node_modules", "bun.lock", "common", "upstash", "instabox"],
});
