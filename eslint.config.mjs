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
    ignores: ["dist", "coverage", "node_modules", "**/*.test.ts", "*.config.mjs"],
  },
];
