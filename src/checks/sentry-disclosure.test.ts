import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sentryDisclosureCheck } from "./sentry-disclosure.js";

describe("sentry-disclosure", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentry-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (plugins: unknown, readme: string): void => {
    writeFileSync(
      join(dir, "io-package.json"),
      JSON.stringify({ common: { plugins } }),
    );
    writeFileSync(join(dir, "README.md"), readme);
  };

  const NOTICE =
    "**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** Details below.";
  const FULL = `# demo\n\n## Sentry / Error reporting\n\n${NOTICE}\n\n## Features\n`;

  it("stays silent without the plugin", () => {
    write({}, "# demo\n");
    expect(sentryDisclosureCheck.run(dir)).toEqual([]);
  });

  it("accepts the standard notice near the top, in any of the checker's four forms, line breaks inside", () => {
    write({ sentry: { dsn: "x" } }, FULL);
    expect(sentryDisclosureCheck.run(dir)).toEqual([]);
    write(
      { sentry: { dsn: "x" } },
      "# demo\nThis adapter uses the service `Sentry.io` to automatically\nreport exceptions and code errors to the developers.\n",
    );
    expect(sentryDisclosureCheck.run(dir)).toEqual([]);
  });

  it("reports a README without the notice — a badge and a heading are not the notice (0.15.0)", () => {
    // tooling audit 2026-09-24 (P10): the check asked for badge + "## Sentry"; the checker (W6023) asks for the notice
    write({ sentry: { dsn: "x" } }, "# demo\n![x](https://s.io/b?logo=sentry)\n\n## Sentry\nWe use Sentry here.\n");
    const [finding] = sentryDisclosureCheck.run(dir);
    expect(finding?.impact).toContain("W6023");
  });

  it("reports the notice after the third ## heading (W6024 as documented), not before", () => {
    const three = ["A", "B", "C"].map((t) => `## ${t}\ntext\n`).join("");
    write({ sentry: { dsn: "x" } }, `# demo\n${three}${NOTICE}\n`);
    const [finding] = sentryDisclosureCheck.run(dir);
    expect(finding?.impact).toContain("W6024");
    const two = ["A", "B"].map((t) => `## ${t}\ntext\n`).join("");
    write({ sentry: { dsn: "x" } }, `# demo\n${two}${NOTICE}\n## C\n`);
    expect(sentryDisclosureCheck.run(dir)).toEqual([]);
  });
});
