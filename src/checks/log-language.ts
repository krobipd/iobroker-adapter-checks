import { readFileSync } from "node:fs";
import { germanPhrasesIn } from "../german.js";
import type { Check, Finding } from "../types.js";
import { listSourceFiles, repoPath, stripTsComments } from "../util.js";

/** Start of a log call or an error construction, up to the opening quote of its first argument. */
const TEXT_START_RE =
  /\b(?:log\s*\.\s*(?:silly|debug|info|warn|error)|new\s+(?:[A-Z]\w*)?Error)\s*\(\s*(["'`])/g;

/**
 * The literal text of a string that opens at `start` (the quote), with every `${…}` of a template removed.
 *
 * @param source the source text
 * @param start index of the opening quote
 * @returns the literal parts, joined by a space
 */
function literalAt(source: string, start: number): string {
  const quote = source[start];
  let out = "";
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      out += source[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (c === quote) {
      break;
    }
    if (quote === "`" && c === "$" && source[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === "{") {
          depth++;
        } else if (source[i] === "}") {
          depth--;
        }
        i++;
      }
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Log lines and error texts are English.
 *
 * ioBroker review (mcm1957, ioBroker.repositories #5667): „use only english wording for all logging messages“;
 * the user-visible translation belongs to datapoint texts and the settings page, never to the log. Only the
 * literal part counts — a device name interpolated into a template is the user's own text.
 */
export const logLanguageCheck: Check = {
  id: "log-language",
  title: "log lines and error texts are written in English",
  run(adapterDir: string): Finding[] {
    const findings: Finding[] = [];
    for (const file of listSourceFiles(adapterDir)) {
      let source: string;
      try {
        source = stripTsComments(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      for (const match of source.matchAll(TEXT_START_RE)) {
        const quoteAt = (match.index ?? 0) + match[0].length - 1;
        const hits = germanPhrasesIn(literalAt(source, quoteAt));
        if (hits.length === 0) {
          continue;
        }
        findings.push({
          check: logLanguageCheck.id,
          file: repoPath(adapterDir, file),
          line: source.slice(0, match.index ?? 0).split("\n").length,
          message: `log or error text is not English (${hits.join(", ")})`,
          impact:
            "ioBroker logs are English — users and maintainers search and report them in one language",
        });
      }
    }
    return findings;
  },
};
