import type { Check, Finding } from "../types.js";
import { readJson, readText } from "../util.js";

/**
 * An adapter that ships the Sentry plugin has to say so in its README.
 *
 * The plugin sends crash reports off the user's machine. That is a reasonable default for
 * a maintainer, but the person installing the adapter deserves to find it without reading
 * the manifest — so the README carries the Sentry badge in its header and a `## Sentry`
 * section explaining what leaves the house and how to switch it off.
 *
 * Conditional by design: without `common.plugins.sentry` there is nothing to disclose and
 * the check stays silent.
 */
export const sentryDisclosureCheck: Check = {
  id: "sentry-disclosure",
  title: "an adapter using the Sentry plugin discloses it in the README",
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
    const findings: Finding[] = [];
    if (!readme.includes("logo=sentry")) {
      findings.push({
        check: sentryDisclosureCheck.id,
        file: "README.md",
        message:
          "the Sentry plugin is active but the header carries no Sentry badge",
        impact: "nothing on the page says that crash reports leave the machine",
      });
    }
    if (!/^## Sentry/m.test(readme)) {
      findings.push({
        check: sentryDisclosureCheck.id,
        file: "README.md",
        message:
          'the Sentry plugin is active but there is no "## Sentry" section',
        impact: "the user cannot see what is reported or how to turn it off",
      });
    }
    return findings;
  },
};
