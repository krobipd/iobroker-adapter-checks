import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Check, Finding } from "../types.js";
import { readJson, readText, stripYamlComments } from "../util.js";

const WORKFLOWS = ".github/workflows";

/**
 * Organisations that run one shared CI standard across every repository — their workflows
 * are managed centrally, a per-repository first reply is not theirs to add.
 */
const CENTRALLY_MANAGED_OWNERS = new Set(["iobroker-community-adapters"]);

/**
 * Owner of the GitHub repository named in package.json, lower-case.
 *
 * Reads every form npm accepts: a URL (`https://github.com/org/repo.git`,
 * `git+https://…`, `git@github.com:org/repo.git`), the `github:org/repo` shorthand and the
 * bare `org/repo` shorthand.
 *
 * @param adapterDir the adapter repository root
 * @returns the owner, or "" when package.json names no GitHub repository
 */
function repositoryOwner(adapterDir: string): string {
  const pkg = readJson<{ repository?: string | { url?: string } }>(
    adapterDir,
    "package.json",
  );
  const raw = (
    typeof pkg?.repository === "string"
      ? pkg.repository
      : (pkg?.repository?.url ?? "")
  ).trim();
  const url = /github\.com[/:]([^/]+)\//i.exec(raw);
  if (url?.[1]) {
    return url[1].toLowerCase();
  }
  const short = /^(?:github:)?([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+$/i.exec(raw);
  return (short?.[1] ?? "").toLowerCase();
}

/**
 * Whether a workflow runs when an issue is opened.
 *
 * Reads only the `on:` trigger — a job that happens to be called `issues` is not a trigger.
 * Accepts `on: issues` / `on: [issues, …]` (every issue event), an `issues:` key without
 * filter or with `{}` (every issue event), and an `issues:` map whose `types` names `opened`
 * — inline, as a flow map or as a block list.
 *
 * @param text the workflow file
 * @returns true when the workflow reacts to newly opened issues
 */
function reactsToOpenedIssues(text: string): boolean {
  const lines = stripYamlComments(text);
  const at = lines.findIndex((l) => /^(['"]?)on\1:/.test(l));
  if (at < 0) {
    return false;
  }
  const inline = (lines[at] ?? "").replace(/^(['"]?)on\1:/, "").trim();
  if (inline !== "") {
    return /(^|[[,\s])issues([\],\s]|$)/.test(inline); // `on: issues`, `on: [push, issues]`
  }
  const block: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === "") {
      continue;
    }
    if (l.search(/\S/) === 0) {
      break;
    }
    block.push(l);
  }
  const first = block[0];
  if (first === undefined) {
    return false;
  }
  const keyIndent = first.search(/\S/);
  const key = block.findIndex(
    (l) => l.search(/\S/) === keyIndent && /^\s*issues:/.test(l),
  );
  if (key < 0) {
    return false;
  }
  const rest = (block[key] ?? "").replace(/^\s*issues:/, "").trim();
  if (rest !== "") {
    return rest === "{}" || /\bopened\b/.test(rest); // `issues: {}` or a flow map naming opened
  }
  const sub: string[] = [];
  for (const l of block.slice(key + 1)) {
    if (l.search(/\S/) <= keyIndent) {
      break;
    }
    sub.push(l);
  }
  if (sub.length === 0) {
    return true; // `issues:` without a filter — every issue event
  }
  const joined = sub.join("\n");
  return (
    /types:\s*\[[^\]]*\bopened\b[^\]]*\]/.test(joined) ||
    /types:\s*opened\b/.test(joined) ||
    /^\s*-\s*['"]?opened['"]?\s*$/m.test(joined)
  );
}

/**
 * A new issue gets an automatic first reply.
 *
 * The reply is where a maintainer's fixed questions live — "is this the current version?",
 * "which controller?" — asked once, immediately, by a workflow triggered on `issues: opened`.
 * Without it every report waits for a human to ask the same things, and reports filed against
 * an outdated version are indistinguishable from real regressions until someone looks.
 *
 * Repositories of a centrally managed organisation (workflows shared across the whole org)
 * are left alone: the first reply is the organisation's decision, not the repository's.
 */
export const firstReplyWorkflowCheck: Check = {
  id: "first-reply-workflow",
  title: "a workflow answers every newly opened issue",
  run(adapterDir: string): Finding[] {
    if (CENTRALLY_MANAGED_OWNERS.has(repositoryOwner(adapterDir))) {
      return [];
    }
    let names: string[];
    try {
      names = readdirSync(join(adapterDir, WORKFLOWS)).sort();
    } catch {
      names = [];
    }
    const workflows = names.filter((n) => /\.ya?ml$/i.test(n));
    const answers = workflows.some((n) =>
      reactsToOpenedIssues(readText(adapterDir, `${WORKFLOWS}/${n}`) ?? ""),
    );
    if (answers) {
      return [];
    }
    return [
      {
        check: firstReplyWorkflowCheck.id,
        file: WORKFLOWS,
        message:
          "no workflow reacts to `issues: opened` — a new issue gets no first reply",
        impact:
          "every report waits for a human to ask the fixed questions, and a report against an outdated version looks like a regression until someone checks",
      },
    ];
  },
};
