import type { Check, Finding } from "../types.js";
import { readJson, readText } from "../util.js";

const WORKFLOW = ".github/workflows/test-and-release.yml";

/**
 * Lowest Node major the adapter declares in `engines.node`.
 *
 * @param adapterDir the adapter repository root
 * @returns the major, or 0 when nothing parseable is declared
 */
function enginesMajor(adapterDir: string): number {
  const pkg = readJson<{ engines?: { node?: string } }>(
    adapterDir,
    "package.json",
  );
  const raw = pkg?.engines?.node ?? "";
  const m = /(\d+)/.exec(raw);
  return m?.[1] ? Number(m[1]) : 0;
}

/**
 * The CI test matrix may not run Node versions the adapter itself rules out.
 *
 * A matrix entry below `engines.node` fails the install with EBADENGINE — the job goes
 * red for a reason that has nothing to do with the code under test.
 */
export const nodeMatrixCheck: Check = {
  id: "node-matrix",
  title: "CI test matrix stays at or above engines.node",
  run(adapterDir: string): Finding[] {
    const wf = readText(adapterDir, WORKFLOW);
    if (wf === undefined) {
      return [];
    }
    const min = enginesMajor(adapterDir);
    if (!min) {
      return [];
    }
    const bad: string[] = [];
    for (const m of wf.matchAll(/node-version:\s*\[([^\]]+)\]/g)) {
      for (const item of (m[1] ?? "").split(",").map((s) => s.trim())) {
        if (!item) {
          continue;
        }
        const major = Number.parseInt(
          item.replace(/['"]/g, "").split(".")[0] ?? "",
          10,
        );
        if (Number.isFinite(major) && major < min) {
          bad.push(item);
        }
      }
    }
    if (bad.length === 0) {
      return [];
    }
    const line = wf
      .slice(0, wf.search(/node-version:\s*\[/))
      .split("\n").length;
    return [
      {
        check: nodeMatrixCheck.id,
        file: WORKFLOW,
        line,
        message: `test matrix runs Node ${bad.join(", ")} although engines.node requires >= ${min}`,
        impact:
          "the install step fails with EBADENGINE on those matrix entries",
      },
    ];
  },
};
