import { changelogCountCheck } from "./checks/changelog-count.js";
import { nodeMatrixCheck } from "./checks/node-matrix.js";
import { secretFieldsCheck } from "./checks/secret-fields.js";
import { switchDefaultCheck } from "./checks/switch-default.js";
import type { Check, Finding, RunOptions } from "./types.js";

export type { Check, Finding, RunOptions } from "./types.js";
export { changelogCountCheck, nodeMatrixCheck, secretFieldsCheck, switchDefaultCheck };

/** Every check this package ships, in a stable order. */
export const allChecks: readonly Check[] = [
  switchDefaultCheck,
  changelogCountCheck,
  nodeMatrixCheck,
  secretFieldsCheck,
];

/**
 * Run every check against one adapter repository.
 *
 * Reads files only — no writes, no network, no child processes — so it is safe to call
 * from a unit test on any developer machine and in CI.
 *
 * @param adapterDir the adapter repository root (where package.json sits)
 * @param options optional ids to skip
 * @returns all findings, in check order; empty means the adapter is clean
 */
export function runChecks(adapterDir: string, options: RunOptions = {}): Finding[] {
  const skip = new Set(options.skip ?? []);
  const findings: Finding[] = [];
  for (const check of allChecks) {
    if (skip.has(check.id)) {
      continue;
    }
    findings.push(...check.run(adapterDir));
  }
  return findings;
}

/**
 * Render findings as a block a developer can act on straight from the test output.
 *
 * @param findings what {@link runChecks} returned
 * @returns one line per finding, empty string when there is nothing to report
 */
export function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map(f => {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      const impact = f.impact ? ` — ${f.impact}` : "";
      return `[${f.check}] ${where}: ${f.message}${impact}`;
    })
    .join("\n");
}
