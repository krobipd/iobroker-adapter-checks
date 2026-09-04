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

  const FULL = "# demo\n![x](https://img.shields.io/badge/a-b?logo=sentry)\n\n## Sentry\ntext\n";

  it("stays silent without the plugin", () => {
    write({}, "# demo\n");
    expect(sentryDisclosureCheck.run(dir)).toEqual([]);
  });

  it("accepts a README with badge and section", () => {
    write({ sentry: { dsn: "x" } }, FULL);
    expect(sentryDisclosureCheck.run(dir)).toEqual([]);
  });

  it("reports a missing badge", () => {
    write({ sentry: { dsn: "x" } }, "# demo\n\n## Sentry\ntext\n");
    const f = sentryDisclosureCheck.run(dir);
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain("badge");
  });

  it("reports a missing section", () => {
    write({ sentry: { dsn: "x" } }, "# demo\n![x](https://s.io/b?logo=sentry)\n");
    const f = sentryDisclosureCheck.run(dir);
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain("Sentry");
  });

  it("reports both when the README says nothing", () => {
    write({ sentry: { dsn: "x" } }, "# demo\n");
    expect(sentryDisclosureCheck.run(dir)).toHaveLength(2);
  });

  it("does not mistake a mention inside a sentence for the section", () => {
    write({ sentry: { dsn: "x" } }, "# demo\n![x](?logo=sentry)\nWe use Sentry here.\n");
    const f = sentryDisclosureCheck.run(dir);
    expect(f).toHaveLength(1);
  });
});
