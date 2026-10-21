import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processEnvCheck } from "./process-env.js";

describe("process-env", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "process-env-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (rel: string, text = "const x = process.env.X;\n"): void => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const files = (): string[] =>
    processEnvCheck
      .run(dir)
      .map((f) => f.file)
      .sort();

  it("reports process.env in the adapter's code, every code extension, also at the root and in lib/", () => {
    put("src/main.ts");
    put("src/lib/pace.ts", 'const y = process.env["Y"];\n');
    put("main.js");
    put("lib/helper.cjs");
    put("lib/esm.mjs");
    expect(files()).toEqual([
      "lib/esm.mjs",
      "lib/helper.cjs",
      "main.js",
      "src/lib/pace.ts",
      "src/main.ts",
    ]);
  });

  it("leaves the files the checker does not scan alone: tests, test/, build/, admin sources, build scripts, dependencies", () => {
    put("src/main.test.ts");
    put("test/inventory-pacing-hook.cjs");
    put("build/main.js");
    put("admin/custom.js");
    put("src-admin/src/app.ts");
    put("scripts/sync.js");
    put("eslint.config.mjs");
    put("tasks.js");
    put("node_modules/x/index.js");
    put("src/tmp/scratch.ts");
    put("src/main.json", '{ "a": "process.env" }\n');
    expect(files()).toEqual([]);
  });

  it("reads a test folder below the root, and a root file named like a skipped folder", () => {
    put("src/test/helper.ts");
    put("build.ts");
    expect(files()).toEqual(["build.ts", "src/test/helper.ts"]);
  });

  it("ignores process.env in comments, not in strings", () => {
    put("src/main.ts", "// process.env.X\n/* process.env.Y */\nconst a = 1;\n");
    put("src/text.ts", 'const t = "process.env is not read";\n');
    expect(files()).toEqual(["src/text.ts"]);
  });

  it("skips a build-tools tasks script at the root and lib/tools unless something requires it", () => {
    put("tasks-build.mjs", 'import "@iobroker/build-tools";\nprocess.env.X;\n');
    put("tasks-own.mjs");
    put("lib/tools.js");
    expect(files()).toEqual(["tasks-own.mjs"]);
    put("main.js", 'const tools = require("./lib/tools");\n');
    expect(files()).toEqual(["lib/tools.js", "tasks-own.mjs"]);
  });

  it("counts every spelling of a lib/tools require the checker counts", () => {
    put("lib/tools.js");
    put(
      "main.js",
      'const tools = require(path.join(__dirname, "lib/tools"));\n',
    );
    expect(files()).toEqual(["lib/tools.js"]);
    put("main.js", "const a = 1;\n");
    put("lib/other.js", 'const tools = require("./tools");\n');
    expect(files()).toEqual(["lib/tools.js"]);
  });

  it("says which rule of the repository checker it mirrors", () => {
    put("src/main.ts");
    const [finding] = processEnvCheck.run(dir);
    expect(finding?.message).toContain("E5049");
    expect(finding?.check).toBe("process-env");
  });
});
