import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noPythonCheck } from "./no-python.js";

describe("no-python", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "no-python-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (rel: string): void => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), "print(1)\n");
  };

  it("reports a python file anywhere in the repository", () => {
    put("scripts/sync.py");
    put("test/tools/gen.py");
    expect(
      noPythonCheck
        .run(dir)
        .map((f) => f.file)
        .sort(),
    ).toEqual(["scripts/sync.py", "test/tools/gen.py"]);
  });

  it("ignores dependencies, git data and build output", () => {
    put("node_modules/x/setup.py");
    put(".git/hooks/x.py");
    put("src-admin/node_modules/y/z.py");
    expect(noPythonCheck.run(dir)).toEqual([]);
  });

  it("is silent for a TypeScript-only repository", () => {
    put("src/main.ts");
    expect(noPythonCheck.run(dir)).toEqual([]);
  });
});
