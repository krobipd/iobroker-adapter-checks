import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeMatrixCheck } from "./node-matrix.js";

describe("node-matrix", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "checks-matrix-"));
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const engines = (spec: string): void =>
    writeFileSync(join(dir, "package.json"), JSON.stringify({ engines: { node: spec } }));
  const workflow = (body: string): void =>
    writeFileSync(join(dir, ".github", "workflows", "test-and-release.yml"), body);

  it("accepts a matrix at or above the declared minimum", () => {
    engines(">= 22");
    workflow("        node-version: [22.x, 24.x]\n");
    expect(nodeMatrixCheck.run(dir)).toEqual([]);
  });

  it("reports an entry below the declared minimum", () => {
    engines(">= 22");
    workflow("        node-version: [20.x, 22.x, 24.x]\n");
    const findings = nodeMatrixCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("20.x");
    expect(findings[0]?.message).toContain(">= 22");
  });

  it("handles quoted entries", () => {
    engines(">= 22");
    workflow(`        node-version: ['20', "24"]\n`);
    expect(nodeMatrixCheck.run(dir)[0]?.message).toContain("'20'");
  });

  it("looks at every matrix in the file", () => {
    engines(">= 22");
    workflow("    node-version: [22.x]\n    node-version: [18.x]\n");
    expect(nodeMatrixCheck.run(dir)[0]?.message).toContain("18.x");
  });

  it("stays silent without a parseable engines entry", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    workflow("        node-version: [18.x]\n");
    expect(nodeMatrixCheck.run(dir)).toEqual([]);
  });

  it("stays silent without a workflow", () => {
    engines(">= 22");
    expect(nodeMatrixCheck.run(dir)).toEqual([]);
  });
});
