import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Check, Finding } from "../types.js";
import { readText } from "../util.js";

/** A reason text that merely restates the adapter's own run state. */
const SELF_STATE =
  /info\.error[^\n]*?["'`]([^"'`]*\b(?:adapter|instance)\b[^"'`]*(?:stop|off|down|not\s+running)[^"'`]*)["'`]/i;

/**
 * All `.ts` sources under src/, excluding tests.
 *
 * @param dir directory to walk
 * @param out collected absolute paths, filled recursively
 * @returns the same array, for convenience at the call site
 */
function sources(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") {
        sources(full, out);
      }
    } else if (
      e.name.endsWith(".ts") &&
      !e.name.endsWith(".test.ts") &&
      !e.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * An error text says what went wrong — not that the adapter is off.
 *
 * A reason state carries the failure the adapter has to report. Writing "adapter is
 * stopped" there describes the very thing the user already sees, and it costs the slot
 * where the real cause belongs. When the adapter itself has nothing to report the value
 * stays empty; anything else is the message of the device or service.
 *
 * Caught here is the give-away shape: a literal next to an `info.error` write that
 * describes the adapter's own run state.
 */
export const errorTextSelfStateCheck: Check = {
  id: "error-text-selfstate",
  title: "an error text names the failure, not the adapter's own run state",
  run(adapterDir: string): Finding[] {
    const srcDir = join(adapterDir, "src");
    try {
      if (!statSync(srcDir).isDirectory()) {
        return [];
      }
    } catch {
      return [];
    }
    const findings: Finding[] = [];
    for (const file of sources(srcDir).sort()) {
      const rel = relative(adapterDir, file).split(sep).join("/");
      const text = readText(adapterDir, rel);
      if (text === undefined) {
        continue;
      }
      text.split("\n").forEach((line, i) => {
        const hit = SELF_STATE.exec(line);
        if (hit) {
          findings.push({
            check: errorTextSelfStateCheck.id,
            file: rel,
            line: i + 1,
            message: `the reason text "${hit[1]}" describes the adapter's own run state`,
            impact:
              "it occupies the slot meant for the real cause, and the user already sees that the instance is off",
          });
        }
      });
    }
    return findings;
  },
};
