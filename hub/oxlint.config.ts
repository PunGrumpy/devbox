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
  ignorePatterns: [...(core.ignorePatterns ?? []), "out"],
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
  ],
  settings: jsPluginSettings,
});
