import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.mjs", "vitest.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The same bar as the fleet's eslint master (tooling round 109/110): no finding is switched off in the code — an
    // inline `eslint-disable` (any inline config) has no effect and lint names it, `@ts-expect-error` is banned like
    // `@ts-ignore`, and a floating promise is an error. The tests are linted too: a check is only as good as the suite
    // that proves it.
    linterOptions: {
      noInlineConfig: true,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true, "ts-check": false },
      ],
    },
  },
  {
    ignores: ["dist", "coverage", "node_modules", "*.config.mjs"],
  },
];
