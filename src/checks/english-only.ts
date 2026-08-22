import type { Check, Finding } from "../types.js";
import { germanPhrasesIn } from "../german.js";
import { readJson, readText } from "../util.js";

/**
 * README and the English release notes have to be English.
 *
 * The repository checker already guards the README (E6015). It does not look at
 * `common.news[*].en` in io-package.json — and that is exactly where a German sentence
 * survives, because the entry is written by hand and the English key is the one everyone
 * copies the source text into.
 */
export const englishOnlyCheck: Check = {
  id: "english-only",
  title: "README and the English release notes read as English",
  run(adapterDir: string): Finding[] {
    const findings: Finding[] = [];

    const readme = readText(adapterDir, "README.md");
    if (readme !== undefined) {
      readme.split("\n").forEach((line, i) => {
        // Lines carrying a link are skipped: a wiki page title may legitimately be
        // German ("[Geräte](…/wiki/Geraete)") without the sentence being German.
        const lower = line.toLowerCase();
        if (
          lower.includes("wiki/") ||
          lower.includes("http://") ||
          lower.includes("https://")
        ) {
          return;
        }
        // An umlaut alone settles it; an ASCII-only line needs two markers.
        const hits = germanPhrasesIn(line);
        const umlaut = hits.includes("(umlaut)");
        if (umlaut || hits.length >= 2) {
          findings.push({
            check: englishOnlyCheck.id,
            file: "README.md",
            line: i + 1,
            message: `line reads as German (${hits.slice(0, 3).join(", ")})`,
            impact: "repochecker E6015 — the README must be English only",
          });
        }
      });
    }

    const iopkg = readJson<{ common?: { news?: Record<string, unknown> } }>(
      adapterDir,
      "io-package.json",
    );
    const news = iopkg?.common?.news;
    if (news && typeof news === "object") {
      for (const [version, entry] of Object.entries(news)) {
        if (typeof entry !== "object" || entry === null) {
          continue;
        }
        const en = (entry as Record<string, unknown>).en;
        if (typeof en !== "string") {
          continue;
        }
        const hits = germanPhrasesIn(en);
        // An umlaut alone is enough here; two markers otherwise.
        if (hits.includes("(umlaut)") || hits.length >= 2) {
          findings.push({
            check: englishOnlyCheck.id,
            file: "io-package.json",
            message: `news[${version}].en reads as German (${hits.slice(0, 3).join(", ")})`,
            impact: "users outside the German locale get the untranslated text",
          });
        }
      }
    }

    return findings;
  },
};
