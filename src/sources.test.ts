import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { typescriptApi } from "./adapter-api.js";
import { FunctionResolver, parseSources } from "./sources.js";
import { listSourceFiles } from "./util.js";

describe("FunctionResolver.resolveModule", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sources-"));
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(join(dir, "src", "main.ts"), 'import { x } from "./lib";\nimport { y } from "./other.js";\n');
    writeFileSync(join(dir, "src", "lib", "index.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "src", "other.ts"), "export const y = 2;\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds a directory import's index.ts and a .js specifier's .ts — keyed like the walker, on every platform", () => {
    // 0.15.0 (tooling audit 2026-09-24, P9): `${base}/index.ts` never matched the Windows keys; the Windows leg of
    // the package CI makes this test sharp there.
    const ts = typescriptApi();
    expect(ts).toBeDefined();
    const files = listSourceFiles(dir);
    const sources = parseSources(ts!, dir, files);
    const resolver = new FunctionResolver(ts!, sources);
    const main = files.find((f) => f.endsWith("main.ts")) as string;
    expect(resolver.resolveModule(main, "./lib")).toBe(files.find((f) => f.endsWith("index.ts")));
    expect(resolver.resolveModule(main, "./other.js")).toBe(files.find((f) => f.endsWith("other.ts")));
    expect(resolver.resolveModule(main, "node:fs")).toBeUndefined();
  });
});
