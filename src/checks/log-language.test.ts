import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logLanguageCheck } from "./log-language.js";

describe("log-language", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "log-language-"));
    mkdirSync(join(dir, "src"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const lines = (text: string, name = "main.ts"): number[] => {
    writeFileSync(join(dir, "src", name), text);
    return logLanguageCheck.run(dir).map((f) => f.line ?? 0);
  };

  it("reports a German log line at every level", () => {
    const text = [
      'this.log.info("Verbindung hergestellt");',
      "this.log.warn('Gerät antwortet nicht');",
      "this.adapter.log.debug(`Abfrage ist fertig für ${id}`);",
      'log.error("Fehler beim Lesen");',
    ].join("\n");
    expect(lines(text)).toEqual([1, 2, 3, 4]);
  });

  it("reports a German error text", () => {
    expect(lines('throw new Error("Datenpunkt fehlt");\n')).toEqual([1]);
  });

  it("judges only the literal part of a template, not an interpolated device name", () => {
    expect(
      lines("this.log.info(`Connected to ${device.name ?? 'Küche'}`);\n"),
    ).toEqual([]);
  });

  it("accepts English text", () => {
    const text = [
      'this.log.info("Connection established");',
      "this.log.warn(`Device ${id} does not answer — is it switched off?`);",
      'throw new Error("datapoint missing");',
    ].join("\n");
    expect(lines(text)).toEqual([]);
  });

  it("ignores comments and tests", () => {
    expect(lines('// this.log.info("Verbindung hergestellt");\n')).toEqual([]);
    expect(
      lines('this.log.info("Verbindung hergestellt");\n', "main.test.ts"),
    ).toEqual([]);
  });
});
