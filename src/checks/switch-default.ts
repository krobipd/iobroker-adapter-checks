import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { Check, Finding } from "../types.js";
import { listSourceFiles } from "../util.js";

/**
 * `switch (…​.command…)` — the onMessage command dispatch. Matched loosely on purpose:
 * the guard is about the shape (`switch` over something ending in `.command`), not about
 * a particular variable name.
 */
const SWITCH_COMMAND_RE = /switch\s*\(\s*[^)]*?\.command\s*[^)]*?\)/gs;

/**
 * Walk from the position right after a `switch (…)` clause to the matching closing brace
 * and report whether a `default:` label appears inside that block.
 *
 * @param source the full file text
 * @param from index right behind the switch clause
 * @returns true when the block has a default label
 */
function blockHasDefault(source: string, from: number): boolean {
  let i = from;
  while (i < source.length && source[i] !== "{") {
    i++;
  }
  if (i >= source.length) {
    return false;
  }
  let depth = 1;
  i++;
  const blockStart = i;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        break;
      }
    }
    i++;
  }
  return /\bdefault\s*:/.test(source.slice(blockStart, i));
}

/**
 * Every command dispatch needs a `default:` branch.
 *
 * Without it an unknown command leaves the caller's callback unanswered until ioBroker's
 * ~5 s timeout fires — the sender sees a hang, the adapter log stays silent.
 */
export const switchDefaultCheck: Check = {
  id: "switch-default",
  title: "every `switch` over a message command has a `default:` branch",
  run(adapterDir: string): Finding[] {
    const findings: Finding[] = [];
    for (const file of listSourceFiles(adapterDir)) {
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const match of source.matchAll(SWITCH_COMMAND_RE)) {
        const end = (match.index ?? 0) + match[0].length;
        if (blockHasDefault(source, end)) {
          continue;
        }
        findings.push({
          check: switchDefaultCheck.id,
          file: relative(adapterDir, file),
          line: source.slice(0, match.index ?? 0).split("\n").length,
          message: "`switch` over a message command without a `default:` branch",
          impact:
            "an unknown command never answers the caller — it hangs until the ioBroker timeout",
        });
      }
    }
    return findings;
  },
};
