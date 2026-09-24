import type { Check, Finding } from "../types.js";
import { readText } from "../util.js";

/**
 * How many versioned entries the README changelog may carry — the same number the repository builder keeps of
 * `common.news` (repochecker W1032: "Repository builder will truncate at 7 news"), so README and news show the same
 * releases. Until 0.15.0 the text named "E6006", a code the checker does not have for this; its own README limit is
 * W6019 (more than 30 entries without CHANGELOG_OLD.md). Tooling audit 2026-09-24, P10.
 */
const MAX_ENTRIES = 7;

/**
 * The README changelog keeps at most seven versioned entries.
 *
 * The work-in-progress heading does not count — the release script replaces it with the
 * new version, so counting it would block a release one entry early.
 */
export const changelogCountCheck: Check = {
  id: "changelog-count",
  title: `README changelog keeps at most ${MAX_ENTRIES} versioned entries`,
  run(adapterDir: string): Finding[] {
    const text = readText(adapterDir, "README.md");
    if (text === undefined) {
      return [];
    }
    const sectionStart = /^## Changelog[ \t]*$/m.exec(text);
    if (!sectionStart) {
      // No changelog section at all — that is a different check's business.
      return [];
    }
    const from = sectionStart.index + sectionStart[0].length;
    const rest = text.slice(from);
    const next = /^## /m.exec(rest);
    const section = rest.slice(0, next ? next.index : rest.length);

    const entries = section.match(/^### .+$/gm) ?? [];
    const versioned = entries.filter(
      (e) => !e.toUpperCase().includes("WORK IN PROGRESS"),
    );
    if (versioned.length <= MAX_ENTRIES) {
      return [];
    }
    return [
      {
        check: changelogCountCheck.id,
        file: "README.md",
        line: text.slice(0, sectionStart.index).split("\n").length,
        message: `## Changelog has ${versioned.length} versioned entries, at most ${MAX_ENTRIES} are allowed`,
        impact:
          "README and common.news drift apart — the repository builder keeps 7 news (repochecker W1032); move the oldest entries to CHANGELOG_OLD.md",
      },
    ];
  },
};
