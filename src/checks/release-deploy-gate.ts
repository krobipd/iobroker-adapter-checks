import type { Check, Finding } from "../types.js";
import { readText, stripYamlComments } from "../util.js";

const WORKFLOW = ".github/workflows/test-and-release.yml";

/** One job of a GitHub Actions workflow: its key, its body (comments removed) and its first line. */
interface Job {
  name: string;
  text: string;
  line: number;
}

/** The workflow, split into its `jobs:` and everything above it. */
interface Parsed {
  /** Text above `jobs:` — triggers and workflow-level permissions live there. */
  header: string;
  jobs: Job[];
  /** False when the jobs section exists but could not be read job by job. */
  readable: boolean;
}

/**
 * Split a workflow into jobs without a YAML parser (the package carries no dependency).
 *
 * The first non-empty line below `jobs:` sets the job-key indentation — two spaces, four,
 * a tab, whatever the file uses. Every line indented deeper than that belongs to the current
 * job; a line at column 0 ends the section. Comments are gone before this runs, so a
 * commented-out job or condition cannot count as one.
 *
 * @param lines the workflow, comments removed
 * @returns header, jobs in file order, and whether the section was readable
 */
function parseWorkflow(lines: string[]): Parsed {
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) {
    return { header: lines.join("\n"), jobs: [], readable: false };
  }
  const header = lines.slice(0, start).join("\n");
  const jobs: Job[] = [];
  let keyIndent = -1;
  let current: Job | undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      if (current) {
        current.text += "\n";
      }
      continue;
    }
    const indent = line.search(/\S/);
    if (indent === 0) {
      break; // next top-level key
    }
    if (keyIndent < 0) {
      keyIndent = indent;
    }
    const head =
      indent === keyIndent
        ? /^\s*['"]?([A-Za-z0-9_-]+)['"]?:\s*$/.exec(line)
        : null;
    if (head?.[1]) {
      current = { name: head[1], text: "", line: i + 1 };
      jobs.push(current);
      continue;
    }
    if (indent <= keyIndent || !current) {
      return { header, jobs, readable: false }; // something at job level that is not a job key
    }
    current.text += `${line}\n`;
  }
  return { header, jobs, readable: true };
}

/**
 * Job names a job declares in `needs:` — inline list, single name or block list.
 *
 * @param job the job (comments already removed)
 * @returns the names; undefined when `needs:` is there but not readable
 */
function needsOf(job: Job): string[] | undefined {
  const lines = job.text.split("\n");
  const at = lines.findIndex((l) => /^\s*needs:/.test(l));
  if (at < 0) {
    return [];
  }
  const rest = (lines[at] ?? "").replace(/^\s*needs:/, "").trim();
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) {
      return undefined;
    }
    return rest
      .slice(1, close)
      .split(",")
      .map((s) => s.trim().replace(/['"]/g, ""))
      .filter(Boolean);
  }
  if (rest !== "") {
    return [rest.replace(/['"]/g, "")];
  }
  const names: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === "") {
      continue;
    }
    const item = /^\s*-\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/.exec(l);
    if (!item?.[1]) {
      break;
    }
    names.push(item[1]);
  }
  return names.length > 0 ? names : undefined;
}

/**
 * Whether the `on:` trigger lets a tag push start the workflow.
 *
 * `on: push` / `on: [push, …]` (unfiltered) fire on tags too; a `push:` map fires on tags
 * when it lists `tags:` or `tags-ignore:`, or carries no `branches`/`tags` filter at all. A `tags:` key anywhere
 * else in the header (under `env:`, say) is not a trigger.
 *
 * @param header the workflow text above `jobs:`, comments removed
 * @returns true when a tag push can start the workflow
 */
function pushTriggersTags(header: string): boolean {
  const lines = header.split("\n");
  const at = lines.findIndex((l) => /^(['"]?)on\1:/.test(l));
  if (at < 0) {
    return false;
  }
  const inline = (lines[at] ?? "").replace(/^(['"]?)on\1:/, "").trim();
  if (inline !== "") {
    return /(^|[[{,\s])push([\]},:\s]|$)/.test(inline); // list, scalar or flow map
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
    (l) => l.search(/\S/) === keyIndent && /^\s*push:/.test(l),
  );
  if (key < 0) {
    return false;
  }
  const rest = (block[key] ?? "").replace(/^\s*push:/, "").trim();
  if (rest !== "") {
    return rest === "{}" || /\btags\b/.test(rest) || !/\bbranches\b/.test(rest);
  }
  const sub: string[] = [];
  for (const l of block.slice(key + 1)) {
    if (l.search(/\S/) <= keyIndent) {
      break;
    }
    sub.push(l);
  }
  const joined = sub.join("\n");
  // GitHub: a ref type with its own filter (`tags` OR `tags-ignore`) triggers; with only the other
  // type's filter defined it does not; with no filter at all every push triggers, tags included.
  if (/^\s*tags(-ignore)?:/m.test(joined)) {
    return true;
  }
  return !/^\s*branches(-ignore)?:/m.test(joined);
}

/** A condition that switches a step or job OFF for tag runs — every spelling seen in the wild. */
const TAG_SKIP =
  /!\s*\(?\s*startsWith\(\s*github\.ref\s*,\s*['"]refs\/tags\/[^'"]*['"]\s*\)|startsWith\(\s*github\.ref\s*,\s*['"]refs\/tags\/[^'"]*['"]\s*\)\s*==\s*false|github\.ref_type\s*!=\s*['"]tag['"]|github\.ref_type\s*==\s*['"]branch['"]/;
/** A condition that switches a job ON for tag runs (not negated). */
const TAG_ONLY =
  /(?<!!\s*\(?\s*)(?<!\w)startsWith\(\s*github\.ref\s*,\s*['"]refs\/tags\/[^'"]*['"]\s*\)(?!\s*==\s*false)|github\.ref_type\s*==\s*['"]tag['"]/;

/**
 * The wait step: github-script polling the branch run of the same commit.
 *
 * @param text a job body, comments removed
 * @returns true when the text carries the wait step
 */
const waits = (text: string): boolean =>
  /uses:\s*actions\/github-script@/.test(text) && /listWorkflowRuns/.test(text);

/**
 * Permission to read workflow runs — explicit, or via the read-all/write-all shorthands.
 *
 * A job that declares its own `permissions:` REPLACES the workflow-level block (GitHub does
 * not merge the two), so the header only counts for a job without an own block.
 *
 * @param job the job that runs the wait step
 * @param header the workflow text above `jobs:`
 * @returns true when that job may read workflow runs
 */
function mayRead(job: Job, header: string): boolean {
  const grants = (text: string): boolean =>
    /^\s*actions:\s*(read|write)\b/m.test(text) ||
    /^\s*permissions:\s*(read-all|write-all)\b/m.test(text);
  return /^\s*permissions:/m.test(job.text) ? grants(job.text) : grants(header);
}

/**
 * A release published from a tag is backed by a test of the same tree.
 *
 * The usual ioBroker workflow runs the full test matrix twice per release — once for the
 * branch push, once for the tag on the same commit. Teams that cut the second run let the
 * test jobs skip their steps on tags (`if: ${{ !startsWith(github.ref, 'refs/tags/') }}`).
 * That is fine only when the deploy job then waits for the branch run of the very same
 * commit (`actions/github-script` + `listWorkflowRuns`, in the deploy job or in a job it
 * needs) and may read it (`actions: read`). A deploy that skips the tests AND does not wait
 * publishes a tree nobody tested — the deploy job is green because its dependencies were
 * skipped, not because they passed. A tag-triggered deploy that needs no job at all is the
 * same thing without the disguise.
 *
 * The standard form (tests run on the tag as well) passes untouched. Every deploy job is
 * judged, and a workflow the check cannot read job by job is a finding, never a pass:
 * silence would claim a proof it has not made.
 */
export const releaseDeployGateCheck: Check = {
  id: "release-deploy-gate",
  title: "a tagged release is backed by a test of the same tree",
  run(adapterDir: string): Finding[] {
    const raw = readText(adapterDir, WORKFLOW);
    if (raw === undefined) {
      return [];
    }
    const lines = stripYamlComments(raw);
    if (!lines.some((l) => /testing-action-deploy/.test(l))) {
      return []; // no deploy — a mention in a comment does not count
    }
    const finding = (
      message: string,
      impact: string,
      line?: number,
    ): Finding => ({
      check: releaseDeployGateCheck.id,
      file: WORKFLOW,
      ...(line === undefined ? {} : { line }),
      message,
      impact,
    });
    const unreadable = (what: string): Finding[] => [
      finding(
        `${what} — the check cannot tell whether a tagged release is backed by a test`,
        "a workflow the check cannot read is not a proof; make the jobs section plain YAML (one job key per line, consistent indentation)",
      ),
    ];
    const parsed = parseWorkflow(lines);
    if (!parsed.readable) {
      return unreadable("the jobs section could not be read job by job");
    }
    const deploys = parsed.jobs.filter((j) =>
      /testing-action-deploy/.test(j.text),
    );
    if (deploys.length === 0) {
      return unreadable(
        "the deploy job (ioBroker/testing-action-deploy) was not found among the readable jobs",
      );
    }
    const out: Finding[] = [];
    for (const deploy of deploys) {
      // Tag-triggered when the job says so; a job without any `if:` inherits the trigger. A job
      // whose `if:` is neither a tag test nor a tag skip (`github.event_name == 'release'`) is not
      // judged — the check cannot tell whether it ever runs on a tag push.
      const tagTriggered =
        TAG_ONLY.test(deploy.text) ||
        (!/^\s*if:/m.test(deploy.text) && pushTriggersTags(parsed.header));
      if (!tagTriggered) {
        continue;
      }
      const needNames = needsOf(deploy);
      if (needNames === undefined) {
        out.push(
          finding(
            `the \`needs:\` of job ${deploy.name} could not be read`,
            "without its dependencies the check cannot tell which tests back the release",
            deploy.line,
          ),
        );
        continue;
      }
      if (needNames.length === 0) {
        out.push(
          finding(
            `job ${deploy.name} publishes on a tag and needs no test job at all`,
            "a tagged release publishes a tree nobody tested",
            deploy.line,
          ),
        );
        continue;
      }
      const needed: Job[] = [];
      let missing: string | undefined;
      for (const name of needNames) {
        const job = parsed.jobs.find((j) => j.name === name);
        if (!job) {
          missing = name;
          break;
        }
        needed.push(job);
      }
      if (missing !== undefined) {
        out.push(
          finding(
            `job ${deploy.name} needs \`${missing}\`, which is not a job the check could read`,
            "a dependency the check cannot see is not a proof",
            deploy.line,
          ),
        );
        continue;
      }
      const skipping = needed.filter((j) => TAG_SKIP.test(j.text));
      if (skipping.length === 0) {
        continue; // the tag run tests itself
      }
      const waiter = waits(deploy.text)
        ? deploy
        : needed.find((j) => waits(j.text));
      if (!waiter) {
        out.push(
          finding(
            `job ${deploy.name} publishes on a tag while ${skipping.map((j) => j.name).join(", ")} skip their test steps on tags and nothing waits for the branch run of the same commit`,
            "a tagged release can publish a tree that was never tested — the dependencies are green because they were skipped",
            deploy.line,
          ),
        );
        continue;
      }
      if (!mayRead(waiter, parsed.header)) {
        out.push(
          finding(
            `job ${waiter.name} waits for the branch run of the same commit but its permissions lack \`actions: read\``,
            "the run lookup answers 403 and every tagged release fails there",
            waiter.line,
          ),
        );
      }
    }
    return out;
  },
};
