import { defineConfig } from "oxlint";

export default defineConfig({
  categories: { correctness: "error", suspicious: "warn" },
  rules: { "no-underscore-dangle": ["warn", { allow: ["_tag"] }] },
  ignorePatterns: ["dist", "node_modules"],
});
