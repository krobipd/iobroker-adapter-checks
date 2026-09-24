import type { Check, Finding } from "../types.js";
import { readJson, readText } from "../util.js";

/**
 * The four sentences the repository checker accepts as the Sentry notice (`SENTRY_NOTICE_TEXT_1..4`,
 * lib/M6000_Readme.js), whitespace-tolerant as it compares them.
 */
const NOTICES = [
  "This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.",
  "This adapter uses the service `Sentry.io` to automatically report exceptions and code errors",
  "This adapter employs Sentry libraries to automatically report exceptions and code errors to the developers.",
  "What is Sentry.io and what is reported to the servers of that company?",
].map(
  (t) =>
    new RegExp(
      t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
    ),
);

/**
 * The notice has to stand before the FIFTH `##` heading (index 4) — the repository checker's
 * `THIRD_H2_HEADER_INDEX = 4` (lib/M6000_Readme.js). The constant's name and a trailing comment still say "third":
 * the first version (2026-05-21) compared against index 2, the maintainer loosened it deliberately to 4 on 2026-06-02
 * (commit ad84ae6, "Minor change to README checking", together with a third accepted notice sentence) and changed the
 * message users see to "near the top". The check follows the maintainer's value, not the leftover comment — 0.15.0
 * read the comment and was stricter than the standard.
 */
const H2_LIMIT_INDEX = 4;

/**
 * An adapter that ships the Sentry plugin says so near the top of its README, in the standard notice.
 *
 * The plugin sends crash reports off the user's machine; the person installing the adapter has to find that without
 * reading the manifest. The standard is the repository checker's: one of its four notice sentences (W6023), placed
 * before the fifth `##` heading (W6024 — see H2_LIMIT_INDEX). Until 0.15.0 this check
 * asked for a Sentry badge and a `## Sentry` heading instead — a fleet convention, not the standard, and a README
 * with both but without the notice passed here and failed the checker (tooling audit 2026-09-24, P10).
 *
 * Conditional by design: without `common.plugins.sentry` there is nothing to disclose and the check stays silent.
 */
export const sentryDisclosureCheck: Check = {
  id: "sentry-disclosure",
  title:
    "an adapter using the Sentry plugin carries the standard Sentry notice near the top of its README",
  run(adapterDir: string): Finding[] {
    const iopkg = readJson<Record<string, unknown>>(
      adapterDir,
      "io-package.json",
    );
    const readme = readText(adapterDir, "README.md");
    if (!iopkg || readme === undefined) {
      return [];
    }
    const asObject = (v: unknown): Record<string, unknown> =>
      typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
    if (!asObject(asObject(iopkg.common).plugins).sentry) {
      return [];
    }
    const match = NOTICES.map((re) => re.exec(readme)).find((m) => m !== null);
    if (!match) {
      return [
        {
          check: sentryDisclosureCheck.id,
          file: "README.md",
          message:
            "the Sentry plugin is active but README.md carries none of the standard Sentry notices",
          impact:
            "repochecker W6023 — nothing on the page says that crash reports leave the machine; add the standard notice near the top",
        },
      ];
    }
    const h2 = [...readme.matchAll(/^##\s+.+$/gm)];
    const limit = h2[H2_LIMIT_INDEX];
    if (limit && match.index > (limit.index ?? 0)) {
      return [
        {
          check: sentryDisclosureCheck.id,
          file: "README.md",
          line: readme.slice(0, match.index).split("\n").length,
          message: 'the Sentry notice stands after the fifth "##" heading',
          impact:
            "repochecker W6024 — move the notice near the top of README.md",
        },
      ];
    }
    return [];
  },
};
