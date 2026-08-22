import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localArtifactsCheck } from "./local-artifacts.js";

describe("local-artifacts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "checks-artifacts-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const gitignore = (text: string): void =>
    writeFileSync(join(dir, ".gitignore"), text);
  const artifactDir = (name: string): void => mkdirSync(join(dir, name));
  const artifactFile = (name: string): void =>
    writeFileSync(join(dir, name), "x");

  it("stays silent when no artifact exists", () => {
    gitignore("");
    expect(localArtifactsCheck.run(dir)).toEqual([]);
  });

  it("reports a dev-server profile that nothing ignores", () => {
    artifactDir(".dev-server");
    gitignore("node_modules/\nbuild/\n");
    const findings = localArtifactsCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(".dev-server");
    expect(findings[0]?.file).toBe(".gitignore");
  });

  it("accepts the plain directory entry", () => {
    artifactDir(".dev-server");
    gitignore(".dev-server/\n");
    expect(localArtifactsCheck.run(dir)).toEqual([]);
  });

  it("accepts the entry without the trailing slash", () => {
    artifactDir(".dev-server");
    gitignore(".dev-server\n");
    expect(localArtifactsCheck.run(dir)).toEqual([]);
  });

  it("accepts a root-anchored entry", () => {
    artifactDir("coverage");
    gitignore("/coverage/\n");
    expect(localArtifactsCheck.run(dir)).toEqual([]);
  });

  it("accepts a leading **/ entry", () => {
    artifactDir("node_modules");
    gitignore("**/node_modules\n");
    expect(localArtifactsCheck.run(dir)).toEqual([]);
  });

  it("accepts a wildcard that covers the artifact", () => {
    artifactDir(".dev-server");
    // The pattern one adapter really uses: every dot-directory.
    gitignore(".*/\n");
    expect(localArtifactsCheck.run(dir)).toEqual([]);
  });

  it("does not let a directory-only rule cover a file", () => {
    artifactFile(".env");
    gitignore(".env/\n");
    expect(localArtifactsCheck.run(dir)).toHaveLength(1);
  });

  it("ignores comments and blank lines", () => {
    artifactDir("coverage");
    gitignore("\n# coverage\n\n");
    expect(localArtifactsCheck.run(dir)).toHaveLength(1);
  });

  it("honours a later re-include", () => {
    artifactDir("coverage");
    gitignore("coverage/\n!coverage\n");
    expect(localArtifactsCheck.run(dir)).toHaveLength(1);
  });

  it("keeps the last matching rule, not the first", () => {
    artifactDir("coverage");
    gitignore("!coverage\ncoverage/\n");
    expect(localArtifactsCheck.run(dir)).toEqual([]);
  });

  it("does not accept a rule that points into a subdirectory", () => {
    artifactDir(".dev-server");
    gitignore(".dev-server/default/package.json\n");
    expect(localArtifactsCheck.run(dir)).toHaveLength(1);
  });

  it("reports every uncovered artifact separately", () => {
    artifactDir(".dev-server");
    artifactDir("coverage");
    artifactFile(".env");
    gitignore("node_modules/\n");
    expect(localArtifactsCheck.run(dir)).toHaveLength(3);
  });

  it("treats a missing .gitignore as covering nothing", () => {
    artifactDir("node_modules");
    expect(localArtifactsCheck.run(dir)).toHaveLength(1);
  });
});
