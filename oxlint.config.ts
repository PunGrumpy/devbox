import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import gdp from "ultracite/oxlint/gdp";
import { jsPluginSettings, selectJsPlugins } from "ultracite/oxlint/js-plugins";
import landmines from "ultracite/oxlint/landmines";
import next from "ultracite/oxlint/next";
import nextJsPlugins from "ultracite/oxlint/next/js-plugins";
import react from "ultracite/oxlint/react";

const jsPlugins = selectJsPlugins(["github", "sonarjs", "react-doctor"]);

interface Exemption {
  rules: readonly string[];
  why: string;
}

const off = (exemptions: readonly Exemption[]) =>
  Object.fromEntries(
    exemptions.flatMap(({ rules }) => rules.map((rule) => [rule, "off"]))
  );

const effectStyle = off([
  {
    rules: [
      "consistent-return",
      "func-names",
      "sonarjs/no-inconsistent-returns",
      "typescript/consistent-return",
    ],
    why: "Effect.gen takes a generator with no name, and code leaves it early with return yield*.",
  },
  {
    rules: [
      "github/array-foreach",
      "promise/prefer-await-to-callbacks",
      "unicorn/no-array-for-each",
      "unicorn/no-array-method-this-argument",
    ],
    why: "Effect.forEach, Effect.filter and Effect.catch are not the array and promise methods of the same names.",
  },
  {
    rules: [
      "no-redeclare",
      "typescript/ban-types",
      "typescript/no-empty-object-type",
      "typescript/no-redeclare",
    ],
    why: "A tagged enum is a type and a constructor under one name, and a case with no fields is {}.",
  },
  {
    rules: ["unicorn/throw-new-error"],
    why: "A tagged error class calls Schema.TaggedError to get its base class.",
  },
  {
    rules: ["max-classes-per-file"],
    why: "Each tagged error is a class, kept beside the code that raises it.",
  },
  {
    rules: [
      "class-methods-use-this",
      "typescript/class-literal-property-style",
    ],
    why: "A tagged error gives its fixed message from a getter, which keeps the message out of the error when it is serialized.",
  },
  {
    rules: ["sonarjs/no-nested-functions"],
    why: "A pipeline of effects nests one closure for each step.",
  },
  {
    rules: ["sonarjs/no-clear-text-protocols"],
    why: "A machine on a tailnet is reached over plain HTTP by design, and WireGuard encrypts the link.",
  },
  {
    rules: [
      "landmines-structure/colocated-tests",
      "landmines-structure/test-file-names",
    ],
    why: "The CLI keeps its tests in test/, one file for each feature.",
  },
  {
    rules: [
      "react-doctor/js-combine-iterations",
      "react-doctor/js-index-maps",
      "react-doctor/js-length-check-first",
      "react-doctor/js-set-map-lookups",
      "react-doctor/no-fetch-response-used-without-status-check",
      "react-doctor/no-unguarded-throwing-parse-call",
    ],
    why: "These rules are written for React apps.",
  },
]);

const fixtures = off([
  {
    rules: ["no-bitwise", "sonarjs/no-hardcoded-ip"],
    why: "A test of code that reads addresses and file modes needs real-looking ones.",
  },
]);

export default defineConfig({
  env: core.env,
  extends: [
    core,
    gdp,
    react,
    next,
    nextJsPlugins,
    antiSlop,
    landmines,
    jsPlugins,
  ],
  ignorePatterns: [...(core.ignorePatterns ?? []), "out", "dist"],
  jsPlugins: [...jsPlugins.jsPlugins, ...landmines.jsPlugins],
  options: { typeAware: true },
  overrides: [
    {
      files: ["**/*.ts", "**/*.tsx"],
      rules: {
        "sonarjs/function-name": "off",
        "sonarjs/no-duplicate-string": "off",
      },
    },
    {
      files: ["apps/cli/**/*.ts"],
      rules: effectStyle,
    },
    {
      files: ["apps/cli/test/**/*.ts"],
      rules: fixtures,
    },
  ],
  settings: jsPluginSettings,
});
