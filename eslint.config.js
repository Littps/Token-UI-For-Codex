import js from "@eslint/js";
import globals from "globals";

const recommendedRules = js.configs.recommended.rules;
const scriptGlobals = {
  ...globals.node,
  ...globals.browser,
};

export default [
  {
    ignores: ["backups/**", "build/**", "dist/**", "release/**"],
  },
  {
    files: ["**/*.mjs", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      ...recommendedRules,
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { caughtErrors: "none" }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "test/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: scriptGlobals,
    },
  },
  {
    files: ["tokens-ui-for-codex-panel.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: globals.browser,
    },
    rules: {
      ...recommendedRules,
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { caughtErrors: "none" }],
    },
  },
];
