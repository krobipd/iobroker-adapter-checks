import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Check, Finding } from "../types.js";
import { readJson } from "../util.js";

/** Languages every adapter documents — the portal serves both, and each user reads one. */
const REQUIRED_LANGS = ["en", "de"] as const;

/**
 * Whether a path names an existing file.
 *
 * @param path absolute path
 * @returns true for a regular file, false for anything else or when it is missing
 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The Markdown pages in one docs folder, sorted; empty when the folder is missing.
 *
 * @param dir absolute folder path
 * @returns file names ending in `.md`
 */
function markdownPages(dir: string): string[] {
  try {
    if (!statSync(dir).isDirectory()) {
      return [];
    }
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * A value as a plain object, or an empty one.
 *
 * @param value anything
 * @returns the value when it is a non-null, non-array object; otherwise `{}`
 */
function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * `common.docs` links the user documentation the ioBroker portal shows.
 *
 * The portal build reads `repo.docs[lang]` from the repository entry and loads exactly those
 * files raw from the repository (`ioBroker.docs`, `engine/build-lib/adapters.js`); without
 * the field it falls back to the README. The FIRST entry per language is the main page —
 * that is where the portal injects changelog, logo, licence and badges from the README.
 *
 * Judged is the structure, never the text: the field exists, both required languages are
 * present, the main page comes first, every linked file exists, no page lies in the folder
 * unlinked (it would be invisible on the portal), and both languages carry the same
 * chapters — otherwise one language silently stops at an older state.
 */
export const commonDocsCheck: Check = {
  id: "common-docs",
  title: "common.docs links complete, matching user documentation in en and de",
  run(adapterDir: string): Finding[] {
    const iopkg = readJson<Record<string, unknown>>(
      adapterDir,
      "io-package.json",
    );
    if (!iopkg) {
      return [];
    }
    const findings: Finding[] = [];
    const report = (file: string, message: string, impact?: string): void => {
      findings.push({ check: commonDocsCheck.id, file, message, impact });
    };

    const docs = asObject(iopkg.common).docs;
    if (
      typeof docs !== "object" ||
      docs === null ||
      Array.isArray(docs) ||
      Object.keys(docs).length === 0
    ) {
      report(
        "io-package.json",
        "common.docs is missing — user documentation belongs in docs/<lang>/README.md and is linked here",
        "without the field the documentation portal shows nothing but the README",
      );
      return findings;
    }
    const entries = docs as Record<string, unknown>;

    for (const lang of REQUIRED_LANGS) {
      if (!(lang in entries)) {
        report(
          "io-package.json",
          `common.docs has no '${lang}' entry`,
          "the portal serves this language and falls back to the README for it",
        );
      }
    }

    const chapters = new Map<string, string[]>();
    for (const [lang, entry] of Object.entries(entries)) {
      const links = Array.isArray(entry) ? entry : [entry];
      if (
        links.length === 0 ||
        !links.every((x): x is string => typeof x === "string")
      ) {
        report(
          "io-package.json",
          `common.docs.${lang} is neither a path nor a list of paths: ${JSON.stringify(entry)}`,
        );
        continue;
      }
      const main = `docs/${lang}/README.md`;
      const first = links[0] ?? "";
      if (first !== main) {
        report(
          "io-package.json",
          `common.docs.${lang} must start with '${main}', it starts with '${first}'`,
          "the first entry is the main page — changelog, logo and badges land there",
        );
      }
      for (const rel of links) {
        if (!isFile(join(adapterDir, rel))) {
          report(
            "io-package.json",
            `common.docs.${lang} links '${rel}', which does not exist`,
            "the portal shows an empty page for it",
          );
        }
      }
      for (const name of markdownPages(join(adapterDir, "docs", lang))) {
        const rel = `docs/${lang}/${name}`;
        if (!links.includes(rel)) {
          report(
            rel,
            `'${name}' lies in docs/${lang}/ but common.docs does not link it`,
            "the portal shows linked pages only — this one is invisible",
          );
        }
      }
      chapters.set(
        lang,
        links.map((x) => x.slice(x.lastIndexOf("/") + 1)),
      );
    }

    // Both required languages carry the same chapters — else one of them keeps an older state.
    const have = REQUIRED_LANGS.filter((lang) => chapters.has(lang));
    const base = have[0];
    if (base !== undefined && have.length === REQUIRED_LANGS.length) {
      const reference = [...(chapters.get(base) ?? [])].sort();
      for (const lang of have.slice(1)) {
        const mine = [...(chapters.get(lang) ?? [])].sort();
        if (JSON.stringify(mine) !== JSON.stringify(reference)) {
          report(
            "io-package.json",
            `common.docs.${lang} carries the chapters ${JSON.stringify(mine)} while ${base} carries ${JSON.stringify(reference)}`,
            "a chapter that exists in one language only leaves the other language's readers without it",
          );
        }
      }
    }
    return findings;
  },
};
