import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueFormsCheck } from "./issue-forms.js";

const FORM = "name: Bug report\ndescription: Something is broken\nbody:\n  - type: input\n    id: version\n";

describe("issue-forms", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "issue-forms-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel: string, text: string): void => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };

  it("reports a repository without the template directory", () => {
    const findings = issueFormsCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(".github/ISSUE_TEMPLATE");
    expect(findings[0].message).toContain("blank editor");
  });

  it("passes a form plus a config that disables blank issues", () => {
    write(".github/ISSUE_TEMPLATE/bug_report.yml", FORM);
    write(".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: false\n");
    expect(issueFormsCheck.run(dir)).toEqual([]);
  });

  it("reports a directory that holds only the config", () => {
    write(".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: false\n");
    const findings = issueFormsCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("no issue form");
  });

  it("does not take a YAML file without name and body for a form", () => {
    write(".github/ISSUE_TEMPLATE/notes.yml", "just: notes\n");
    write(".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: false\n");
    const findings = issueFormsCheck.run(dir);
    expect(findings.map((f) => f.message)).toEqual([
      expect.stringContaining("no issue form"),
    ]);
  });

  it("reports a missing config", () => {
    write(".github/ISSUE_TEMPLATE/bug_report.yml", FORM);
    const findings = issueFormsCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(".github/ISSUE_TEMPLATE/config.yml");
    expect(findings[0].message).toContain("config.yml is missing");
  });

  it("reports a config that still allows blank issues", () => {
    write(".github/ISSUE_TEMPLATE/bug_report.yml", FORM);
    write(".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: true\n");
    const findings = issueFormsCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("blank_issues_enabled is not false");
  });

  it("does not take a config.yaml for the chooser file GitHub reads", () => {
    write(".github/ISSUE_TEMPLATE/bug_report.yml", FORM);
    write(".github/ISSUE_TEMPLATE/config.yaml", "blank_issues_enabled: false\n");
    const findings = issueFormsCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("config.yaml");
  });

  it("reports a legacy Markdown template beside the forms", () => {
    write(".github/ISSUE_TEMPLATE/bug_report.yml", FORM);
    write(".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: false\n");
    write(".github/ISSUE_TEMPLATE/bug_report.md", "---\nname: Bug\n---\n");
    const findings = issueFormsCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(".github/ISSUE_TEMPLATE/bug_report.md");
    expect(findings[0].impact).toContain("unguided");
  });
});
