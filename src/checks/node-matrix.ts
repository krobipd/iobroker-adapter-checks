import type { Check, Finding } from "../types.js";
import { readJson, readText, stripYamlComments } from "../util.js";

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
 * A matrix entry below `engines.node` tests a Node version the adapter declares unsupported: npm only warns
 * (EBADENGINE is a warning unless `engine-strict` is set — `npm ci` ends with exit 0), the job runs, and its green
 * result says nothing about any installation the adapter allows.
 */
export const nodeMatrixCheck: Check = {
  id: "node-matrix",
  title: "CI test matrix stays at or above engines.node",
  run(adapterDir: string): Finding[] {
    const raw = readText(adapterDir, WORKFLOW);
    if (raw === undefined) {
      return [];
    }
    const wf = stripYamlComments(raw).join("\n"); // a commented-out matrix line is no matrix entry
    const min = enginesMajor(adapterDir);
    if (!min) {
      return [];
    }
    const bad: string[] = [];
    let first = -1;
    // Both list forms YAML allows: the flow list `[20.x, 22.x]` and the block list (`- 20.x` per line) — the block
    // form passed unchecked before.
    const lists = [
      ...[...wf.matchAll(/node-version:[ \t]*\[([^\]]+)\]/g)].map((m) => ({
        at: m.index,
        items: (m[1] ?? "").split(","),
      })),
      // An item sits at least at the key's indentation (YAML allows the same column); a shallower `- uses:` that
      // follows belongs to the steps, not to the list.
      ...[
        ...wf.matchAll(
          /^([ \t]*)node-version:[ \t]*\n((?:\1[ \t]*-[ \t]*[^\n]*\n?)+)/gm,
        ),
      ].map((m) => ({
        at: m.index,
        items: (m[2] ?? "")
          .split("\n")
          .map((l) => l.replace(/^[ \t]*-[ \t]*/, "")),
      })),
    ];
    for (const list of lists) {
      for (const item of list.items.map((s) => s.trim())) {
        if (!item) {
          continue;
        }
        const major = Number.parseInt(
          item.replace(/['"]/g, "").split(".")[0] ?? "",
          10,
        );
        if (Number.isFinite(major) && major < min) {
          bad.push(item);
          if (first < 0 || list.at < first) {
            first = list.at;
          }
        }
      }
    }
    if (bad.length === 0) {
      return [];
    }
    const line = wf.slice(0, first).split("\n").length;
    return [
      {
        check: nodeMatrixCheck.id,
        file: WORKFLOW,
        line,
        message: `test matrix runs Node ${bad.join(", ")} although engines.node requires >= ${min}`,
        impact:
          "those jobs test a Node version the adapter rules out — npm only warns (EBADENGINE), so the result proves nothing about a supported installation",
      },
    ];
  },
};
