import type { Check, Finding } from "../types.js";
import {
  CHANGELOG_PHRASE_ALLOWLIST,
  TOOLING_BACKTICK_ALLOW,
  TOOLING_BACKTICK_RE,
  TOOLING_PATTERNS,
  TOOLING_REGEX_PATTERNS,
} from "../patterns.js";
import { readJson } from "../util.js";

/** A bare word must match as a word — otherwise "nyc" fires inside Polish genitives. */
const BARE_WORD_RE = /^[a-z0-9_-]+$/;

/**
 * Does a tooling pattern appear in this text?
 *
 * @param lower the text, lower-cased
 * @param pattern one entry of {@link TOOLING_PATTERNS}
 * @returns true when the pattern is present
 */
function patternMatches(lower: string, pattern: string): boolean {
  if (BARE_WORD_RE.test(pattern)) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(lower);
  }
  return lower.includes(pattern);
}

/**
 * Inspect one changelog text — a release note string or a README bullet.
 *
 * @param text the text as written
 * @param label where it came from, used in the message
 * @param maxLineLength longest allowed bullet line
 * @returns one message per problem, empty when the text is fine
 */
export function checkChangelogText(
  text: string,
  label: string,
  maxLineLength: number,
): string[] {
  const out: string[] = [];

  for (const line of text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    if (line.length > maxLineLength) {
      out.push(
        `${label}: bullet line is ${line.length} characters, the limit is ${maxLineLength} per line`,
      );
    }
  }

  const lower = text.trim().toLowerCase();
  if (!CHANGELOG_PHRASE_ALLOWLIST.some((allowed) => lower === allowed)) {
    const hits = TOOLING_PATTERNS.filter((p) => patternMatches(lower, p));
    if (hits.length > 0) {
      out.push(
        `${label}: reads as tooling internals (${hits.slice(0, 3).join(", ")})`,
      );
    }
    const regexHits = TOOLING_REGEX_PATTERNS.filter(([re]) =>
      re.test(lower),
    ).map(([, name]) => name);
    if (regexHits.length > 0) {
      out.push(
        `${label}: developer category (${regexHits.slice(0, 3).join(", ")})`,
      );
    }
  }

  for (const m of text.matchAll(TOOLING_BACKTICK_RE)) {
    const ident = m[0].replaceAll("`", "");
    if (!TOOLING_BACKTICK_ALLOW.has(ident)) {
      out.push(
        `${label}: carries the internal identifier \`${ident}\` — users read effects, not code names`,
      );
      break; // one is enough to make the point
    }
  }

  return out;
}

/** How long a single bullet line may get before it stops being readable. */
const MAX_LINE_LENGTH = 200;

/**
 * Release notes are written for users.
 *
 * A note that names the test runner, the build config or an internal field tells the
 * reader nothing about their installation. This looks at `common.news` in
 * io-package.json, where the text ends up in the admin update dialog.
 */
export const changelogStyleCheck: Check = {
  id: "changelog-style",
  title: "release notes read as user-facing text",
  run(adapterDir: string): Finding[] {
    const iopkg = readJson<{ common?: { news?: Record<string, unknown> } }>(
      adapterDir,
      "io-package.json",
    );
    const news = iopkg?.common?.news;
    if (!news || typeof news !== "object") {
      return [];
    }
    const findings: Finding[] = [];
    for (const [version, entry] of Object.entries(news)) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const en = (entry as Record<string, unknown>).en;
      if (typeof en !== "string") {
        continue;
      }
      for (const message of checkChangelogText(
        en,
        `news[${version}].en`,
        MAX_LINE_LENGTH,
      )) {
        findings.push({
          check: changelogStyleCheck.id,
          file: "io-package.json",
          message,
          impact: "this text is what users see in the admin update dialog",
        });
      }
    }
    return findings;
  },
};

/** Exported so an adapter can reuse the text check on its own README bullets. */
export { MAX_LINE_LENGTH };
