import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { englishOnlyCheck } from "./english-only.js";

describe("english-only", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "checks-english-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const readme = (body: string): void => writeFileSync(join(dir, "README.md"), body);
  const news = (entries: Record<string, unknown>): void =>
    writeFileSync(join(dir, "io-package.json"), JSON.stringify({ common: { news: entries } }));

  it("accepts an English README", () => {
    readme("# Adapter\n\nReads values from the device and writes them to states.\n");
    expect(englishOnlyCheck.run(dir)).toEqual([]);
  });

  it("reports a German README line with its line number", () => {
    readme("# Adapter\n\nDie Verbindung wird jetzt in der Instanz behoben.\n");
    const findings = englishOnlyCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(3);
  });

  it("does not trip over a single marker in an English line", () => {
    // "Versionen" is one marker and there is no umlaut — one hit is not enough.
    readme("Versionen 1 and 2 are supported\n");
    expect(englishOnlyCheck.run(dir)).toEqual([]);
  });

  it("counts an umlaut as a marker of its own in the README", () => {
    readme("Supported: Geräte X1\n");
    expect(englishOnlyCheck.run(dir)).toHaveLength(1);
  });

  it("leaves a link line alone even with a German page title", () => {
    readme("| Devices | [Geräte](https://github.com/x/y/wiki/Geraete) |\n");
    expect(englishOnlyCheck.run(dir)).toEqual([]);
  });

  it("reports a German release note, umlaut alone is enough", () => {
    news({ "1.0.0": { en: "Gerät neu verbunden", de: "Gerät neu verbunden" } });
    const findings = englishOnlyCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("news[1.0.0].en");
  });

  it("accepts an English release note", () => {
    news({ "1.0.0": { en: "Reconnects on its own after a network drop", de: "…" } });
    expect(englishOnlyCheck.run(dir)).toEqual([]);
  });

  it("matches whole words only — 'parsed' is not 'parsen'", () => {
    news({ "1.0.0": { en: "Values are parsed before they reach a state" } });
    expect(englishOnlyCheck.run(dir)).toEqual([]);
  });

  it("ignores release notes that are not objects or have no English key", () => {
    news({ "1.0.0": "plain string", "1.0.1": { de: "nur deutsch" } });
    expect(englishOnlyCheck.run(dir)).toEqual([]);
  });

  it("stays silent without README and manifest", () => {
    expect(englishOnlyCheck.run(dir)).toEqual([]);
  });
});
