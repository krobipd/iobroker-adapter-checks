import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changelogStyleCheck, checkChangelogText } from "./changelog-style.js";

describe("changelog-style", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "checks-style-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const news = (entries: Record<string, unknown>): void =>
    writeFileSync(join(dir, "io-package.json"), JSON.stringify({ common: { news: entries } }));

  it("accepts a user-facing note", () => {
    news({ "1.0.0": { en: "The device reconnects on its own after a network drop" } });
    expect(changelogStyleCheck.run(dir)).toEqual([]);
  });

  it("reports a note that names the test runner", () => {
    news({ "1.0.0": { en: "Switched the suite from mocha to vitest" } });
    const findings = changelogStyleCheck.run(dir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toContain("tooling internals");
  });

  it("reports an internal identifier in backticks", () => {
    news({ "1.0.0": { en: "The `deviceState` value is refreshed sooner" } });
    expect(changelogStyleCheck.run(dir)[0]?.message).toContain("deviceState");
  });

  it("allows identifiers users actually see in the object tree", () => {
    news({ "1.0.0": { en: "`info.connection` now turns false while the device is away" } });
    expect(changelogStyleCheck.run(dir)).toEqual([]);
  });

  it("reports an over-long bullet line", () => {
    news({ "1.0.0": { en: "x".repeat(201) } });
    expect(changelogStyleCheck.run(dir)[0]?.message).toContain("201 characters");
  });

  it("measures each bullet line on its own, not the whole entry", () => {
    news({ "1.0.0": { en: `${"a".repeat(150)}\n${"b".repeat(150)}` } });
    expect(changelogStyleCheck.run(dir)).toEqual([]);
  });

  it("lets the accepted phrases through", () => {
    news({ "1.0.0": { en: "Internal refactoring. No user-facing changes." } });
    expect(changelogStyleCheck.run(dir)).toEqual([]);
  });

  it("matches bare words as words — 'nyc' does not fire inside another word", () => {
    expect(checkChangelogText("Widocznych changes for everyone", "x", 200)).toEqual([]);
  });

  it("catches a developer category by pattern, not by word list", () => {
    const out = checkChangelogText("Reduced HTTP retries after a timeout", "x", 200);
    expect(out.join(" ")).toContain("protocol-internal");
  });

  it("stays silent without release notes", () => {
    expect(changelogStyleCheck.run(dir)).toEqual([]);
  });
});
