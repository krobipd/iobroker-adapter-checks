import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseDeployGateCheck } from "./release-deploy-gate.js";

const HEADER = `name: Test and Release
on:
  push:
    branches:
      - main
    tags:
      - "v*"
  pull_request: {}
jobs:
  check-and-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;

const TESTS = (stepIf: string): string => `  adapter-tests:
    needs: [check-and-lint]
    runs-on: ubuntu-latest
    steps:
      - ${stepIf}uses: ioBroker/testing-action-adapter@v1
        with:
          node-version: 22.x
`;

const WAIT_STEP = `      - name: Wait for the green main-branch run of this commit
        uses: actions/github-script@v7
        with:
          script: |
            const { data } = await github.rest.actions.listWorkflowRuns({ owner: 1 });
`;

const DEPLOY = (opts: {
  wait: boolean;
  read: boolean;
  needs?: string;
  cond?: string;
}): string => `  deploy:
    ${opts.needs ?? "needs: [check-and-lint, adapter-tests]"}
    if: |
      github.event_name == 'push' &&
      ${opts.cond ?? "startsWith(github.ref, 'refs/tags/v')"}
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
${opts.read ? "      actions: read\n" : ""}    steps:
${opts.wait ? WAIT_STEP : ""}      - uses: ioBroker/testing-action-deploy@v1
        with:
          node-version: "24.x"
`;

const SKIP = "if: ${{ !startsWith(github.ref, 'refs/tags/') }}\n        ";

describe("release-deploy-gate", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deploy-gate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const workflow = (text: string): void => {
    const full = join(dir, ".github/workflows/test-and-release.yml");
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  const run = (): ReturnType<typeof releaseDeployGateCheck.run> =>
    releaseDeployGateCheck.run(dir);

  it("says nothing without a workflow or without a deploy job", () => {
    expect(run()).toEqual([]);
    workflow(HEADER + TESTS(""));
    expect(run()).toEqual([]);
  });

  it("passes the standard form — the tag run tests itself", () => {
    workflow(HEADER + TESTS("") + DEPLOY({ wait: false, read: false }));
    expect(run()).toEqual([]);
  });

  it("passes a tag run that skips the tests but waits for the branch run", () => {
    workflow(HEADER + TESTS(SKIP) + DEPLOY({ wait: true, read: true }));
    expect(run()).toEqual([]);
  });

  it("reports a deploy that skips the tests on tags and waits for nothing", () => {
    workflow(HEADER + TESTS(SKIP) + DEPLOY({ wait: false, read: true }));
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(".github/workflows/test-and-release.yml");
    expect(findings[0].message).toContain("adapter-tests");
    expect(findings[0].message).toContain("nothing waits");
  });

  it("points at the line of the deploy job", () => {
    const text = HEADER + TESTS(SKIP) + DEPLOY({ wait: false, read: true });
    workflow(text);
    const expected = text.split("\n").findIndex((l) => l === "  deploy:") + 1;
    expect(run()[0].line).toBe(expected);
  });

  it("reports a waiting deploy that may not read the runs", () => {
    workflow(HEADER + TESTS(SKIP) + DEPLOY({ wait: true, read: false }));
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("actions: read");
  });

  it("accepts the read-all shorthand on workflow level for a job without its own block", () => {
    const noJobBlock = DEPLOY({ wait: true, read: false }).replace(
      /    permissions:\n      contents: write\n      id-token: write\n/,
      "",
    );
    workflow(HEADER.replace("jobs:\n", "permissions: read-all\njobs:\n") + TESTS(SKIP) + noJobBlock);
    expect(run()).toEqual([]);
  });

  it("accepts the wait step in a job the deploy needs", () => {
    const waiter = `  wait-for-branch-run:
    runs-on: ubuntu-latest
    permissions:
      actions: read
    steps:
${WAIT_STEP}`;
    workflow(
      HEADER +
        TESTS(SKIP) +
        waiter +
        DEPLOY({ wait: false, read: false, needs: "needs: [check-and-lint, adapter-tests, wait-for-branch-run]" }),
    );
    expect(run()).toEqual([]);
  });

  it("reads needs written as a block list, also with a comment on the key", () => {
    workflow(
      HEADER +
        TESTS(SKIP) +
        DEPLOY({ wait: false, read: true, needs: "needs: # the gates\n      - check-and-lint\n      - adapter-tests" }),
    );
    expect(run()).toHaveLength(1);
  });

  it("reads jobs indented with four spaces", () => {
    const four = (HEADER + TESTS(SKIP) + DEPLOY({ wait: false, read: true }))
      .split("\n")
      .map((l) => (/^ {2}\S/.test(l) || /^ {4,}/.test(l) ? `  ${l}` : l))
      .join("\n");
    workflow(four);
    expect(run()).toHaveLength(1);
  });

  it("is not derailed by comments at column 0, after `jobs:` or after a job key", () => {
    const text = (HEADER + TESTS(SKIP) + DEPLOY({ wait: false, read: true }))
      .replace("jobs:\n", "jobs: # every job\n")
      .replace("  adapter-tests:\n", "# the matrix\n  adapter-tests: # six ways\n");
    workflow(text);
    expect(run()).toHaveLength(1);
  });

  it("does not take a commented-out skip condition for one", () => {
    workflow(
      HEADER +
        TESTS("# historic: if: ${{ !startsWith(github.ref, 'refs/tags/') }}\n        ") +
        DEPLOY({ wait: false, read: false }),
    );
    expect(run()).toEqual([]);
  });

  it("recognises the other spellings of a tag skip", () => {
    for (const cond of [
      "if: ${{ !(startsWith(github.ref, 'refs/tags/')) }}",
      "if: ${{ startsWith(github.ref, \"refs/tags/\") == false }}",
      "if: ${{ github.ref_type != 'tag' }}",
    ]) {
      workflow(HEADER + TESTS(`${cond}\n        `) + DEPLOY({ wait: false, read: true }));
      expect(run(), cond).toHaveLength(1);
    }
  });

  it("reports a jobs section it cannot read instead of passing", () => {
    workflow(HEADER + "  - not a job key\n" + TESTS(SKIP) + DEPLOY({ wait: false, read: true }));
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("could not be read");
  });

  it("reports a needed job it cannot find instead of passing", () => {
    workflow(HEADER + TESTS(SKIP) + DEPLOY({ wait: false, read: true, needs: "needs: [check-and-lint, adapter-tests, ghost]" }));
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("ghost");
  });

  it("reports a tag-triggered deploy that needs no job at all", () => {
    workflow(HEADER + TESTS("") + DEPLOY({ wait: false, read: false, needs: "runs-on: ubuntu-latest" }));
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("needs no test job");
  });

  it("judges every deploy job, not only the first", () => {
    const beta = DEPLOY({ wait: true, read: true }).replace("  deploy:\n", "  deploy-beta:\n");
    workflow(HEADER + TESTS(SKIP) + beta + DEPLOY({ wait: false, read: true }));
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("job deploy ");
  });

  it("knows that a job-level permissions block replaces the workflow-level one", () => {
    const header = HEADER.replace("jobs:\n", "permissions:\n  actions: read\njobs:\n");
    workflow(header + TESTS(SKIP) + DEPLOY({ wait: true, read: false }));
    expect(run()).toHaveLength(1);
    const noJobBlock = DEPLOY({ wait: true, read: false }).replace(/    permissions:\n      contents: write\n      id-token: write\n/, "");
    workflow(header + TESTS(SKIP) + noJobBlock);
    expect(run()).toEqual([]);
  });

  it("reads a job key written in quotes", () => {
    workflow((HEADER + TESTS("") + DEPLOY({ wait: false, read: false })).replace("  deploy:\n", '  "deploy":\n'));
    expect(run()).toEqual([]);
  });

  it("does not take a deploy mentioned only in a comment for one", () => {
    workflow(HEADER + TESTS(SKIP) + "  # the deploy (ioBroker/testing-action-deploy) lives in release.yml\n");
    expect(run()).toEqual([]);
  });

  it("does not take a tags key under env for a trigger", () => {
    const header = HEADER.replace('    tags:\n      - "v*"\n', "").replace("jobs:\n", "env:\n  tags: none\njobs:\n");
    workflow(header + TESTS(SKIP) + DEPLOY({ wait: false, read: false, cond: "github.ref == 'refs/heads/main'" }));
    expect(run()).toEqual([]);
  });

  it("treats tags-ignore as a tag filter that still fires on the other tags", () => {
    const header = HEADER.replace("    tags:\n      - \"v*\"\n", "    tags-ignore:\n      - \"rc-*\"\n");
    const deploy = DEPLOY({ wait: false, read: false }).replace(/    if: \|\n(?:.*\n){2}/, "");
    workflow(header + TESTS(SKIP) + deploy);
    expect(run()).toHaveLength(1);
    const noTags = HEADER.replace("    tags:\n      - \"v*\"\n", "");
    workflow(noTags + TESTS(SKIP) + deploy);
    expect(run()).toEqual([]);
  });

  it("reads a flow map on the on: line", () => {
    const header = HEADER.replace(/on:\n(?:  .*\n)+jobs:\n/, "on: {push: {tags: ['v*']}}\njobs:\n");
    const deploy = DEPLOY({ wait: false, read: false }).replace(/    if: \|\n(?:.*\n){2}/, "");
    workflow(header + TESTS(SKIP) + deploy);
    expect(run()).toHaveLength(1);
  });

  it("does not judge a deploy whose if is neither a tag test nor a tag skip", () => {
    workflow(HEADER + TESTS("") + DEPLOY({ wait: false, read: false, needs: "runs-on: ubuntu-latest", cond: "github.event_name == 'release'" }));
    expect(run()).toEqual([]);
  });

  it("treats an unfiltered push trigger as tag-capable for a deploy without an if", () => {
    const header = HEADER.replace("  push:\n    branches:\n      - main\n    tags:\n      - \"v*\"\n", "  push:\n");
    const deploy = DEPLOY({ wait: false, read: false }).replace(/    if: \|\n(?:.*\n){2}/, "");
    workflow(header + TESTS(SKIP) + deploy);
    expect(run()).toHaveLength(1);
  });

  it("ignores a deploy that is not tag-triggered", () => {
    const noTags = HEADER.replace('    tags:\n      - "v*"\n', "");
    workflow(noTags + TESTS(SKIP) + DEPLOY({ wait: false, read: false, cond: "github.ref == 'refs/heads/main'" }));
    expect(run()).toEqual([]);
  });
});
