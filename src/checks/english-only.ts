import type { Check, Finding } from "../types.js";
import { germanPhrasesIn } from "../german.js";
import { readJson, readText } from "../util.js";

/**
 * The README as a reader sees it, line numbers kept: fenced code blocks, inline code, blockquote lines and image markup
 * are blanked, a link keeps only its visible text — the repository checker strips the same before it looks for German
 * (`stripMarkdownForLanguageDetection`, lib/M6000_Readme.js). Until 0.15.0 a German device message inside a code
 * block, or a German name, made the README "German" (tooling audit 2026-09-24, P6).
 *
 * @param text the README
 * @returns the visible text, same line count
 */
export function visibleReadmeText(text: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, "");
  return text
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/`[^`\n]*`/g, "")
    .replace(/^[ \t]*>.*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
}

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
      const original = readme.split("\n");
      visibleReadmeText(readme)
        .split("\n")
        .forEach((line, i) => {
          // Lines carrying a link are skipped: a wiki page title may legitimately be
          // German ("[Geräte](…/wiki/Geraete)") without the sentence being German. Decided on the ORIGINAL line — the
          // visible text has the URL stripped already.
          const lower = (original[i] ?? "").toLowerCase();
          if (
            lower.includes("wiki/") ||
            lower.includes("http://") ||
            lower.includes("https://")
          ) {
            return;
          }
          // Two markers — an umlaut counts as one. A single umlaut is a name ("Jörg" in the credits), not a sentence;
          // the repository checker needs three German words (GERMAN_WORD_DETECTION_LIMIT), this stays stricter.
          const hits = germanPhrasesIn(line);
          if (hits.length >= 2) {
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
        // An umlaut alone is enough here (a release note carries no names, and "Gerät neu verbunden" has one marker
        // word); two markers otherwise.
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
