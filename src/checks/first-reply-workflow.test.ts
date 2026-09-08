import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firstReplyWorkflowCheck } from "./first-reply-workflow.js";

describe("first-reply-workflow", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "first-reply-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel: string, text: string): void => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  const repo = (url: string): void => {
    write("package.json", JSON.stringify({ repository: { type: "git", url } }));
  };
  const own = (): void => repo("https://github.com/someone/ioBroker.demo.git");

  it("reports a repository whose workflows never react to a new issue", () => {
    own();
    write(".github/workflows/test-and-release.yml", "on:\n  push:\n    branches: [main]\n");
    const findings = firstReplyWorkflowCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(".github/workflows");
    expect(findings[0].message).toContain("issues: opened");
  });

  it("reports a repository without any workflow", () => {
    own();
    expect(firstReplyWorkflowCheck.run(dir)).toHaveLength(1);
  });

  it("passes a workflow triggered on opened issues (inline types)", () => {
    own();
    write(".github/workflows/new-issue.yml", "name: New issue\non:\n  issues:\n    types: [opened]\njobs: {}\n");
    expect(firstReplyWorkflowCheck.run(dir)).toEqual([]);
  });

  it("passes a block list of types that names opened", () => {
    own();
    write(".github/workflows/new-issue.yml", "on:\n  issues:\n    types:\n      - edited\n      - opened\n");
    expect(firstReplyWorkflowCheck.run(dir)).toEqual([]);
  });

  it("passes the shorthands that subscribe to every issue event", () => {
    own();
    for (const text of [
      "on: [issues]\n",
      "on: [push, issues]\n",
      "on: issues\n",
      "on:\n  issues:\njobs: {}\n",
      "on:\n  issues: {}\njobs: {}\n",
      "on:\n  issues: # every event\njobs: {}\n",
    ]) {
      write(".github/workflows/a.yml", text);
      expect(firstReplyWorkflowCheck.run(dir), text).toEqual([]);
    }
  });

  it("does not count an issues trigger that excludes opened", () => {
    own();
    write(".github/workflows/new-issue.yml", "on:\n  issues:\n    types: [edited, closed]\n");
    expect(firstReplyWorkflowCheck.run(dir)).toHaveLength(1);
  });

  it("does not take a job called issues for a trigger", () => {
    own();
    write(".github/workflows/a.yml", "on:\n  push:\njobs:\n  issues:\n    steps:\n      - opened\n");
    expect(firstReplyWorkflowCheck.run(dir)).toHaveLength(1);
  });

  it("does not take a commented-out trigger for one", () => {
    own();
    write(".github/workflows/a.yml", "on:\n  push:\n  # issues:\n  #   types: [opened]\n");
    expect(firstReplyWorkflowCheck.run(dir)).toHaveLength(1);
  });

  it("leaves a centrally managed organisation alone, in every repository spelling", () => {
    for (const url of [
      "https://github.com/iobroker-community-adapters/ioBroker.demo.git",
      "git+https://github.com/iobroker-community-adapters/ioBroker.demo.git",
      "git@github.com:iobroker-community-adapters/ioBroker.demo.git",
      "github:iobroker-community-adapters/ioBroker.demo",
      "iobroker-community-adapters/ioBroker.demo",
    ]) {
      repo(url);
      expect(firstReplyWorkflowCheck.run(dir), url).toEqual([]);
    }
    write("package.json", JSON.stringify({ repository: "iobroker-community-adapters/ioBroker.demo" }));
    expect(firstReplyWorkflowCheck.run(dir)).toEqual([]);
  });
});
