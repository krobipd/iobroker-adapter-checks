import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stopInstanceCheck } from "./stop-instance.js";

describe("stop-instance", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stop-instance-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const manifest = (common: unknown): void => {
    writeFileSync(join(dir, "io-package.json"), JSON.stringify({ common }));
  };

  it("says nothing when the key is absent", () => {
    manifest({ name: "demo" });
    expect(stopInstanceCheck.run(dir)).toEqual([]);
  });

  it("reports the entry when it is set", () => {
    manifest({ supportedMessages: { stopInstance: true } });
    const findings = stopInstanceCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("io-package.json");
    expect(findings[0].impact).toContain("onUnload");
  });

  it("leaves deviceManager alone", () => {
    manifest({ supportedMessages: { deviceManager: true } });
    expect(stopInstanceCheck.run(dir)).toEqual([]);
  });

  it("treats an explicit false as not set", () => {
    manifest({ supportedMessages: { stopInstance: false } });
    expect(stopInstanceCheck.run(dir)).toEqual([]);
  });

  it("survives a manifest whose common is not an object", () => {
    manifest("nonsense");
    expect(stopInstanceCheck.run(dir)).toEqual([]);
  });

  it("says nothing without a manifest", () => {
    expect(stopInstanceCheck.run(dir)).toEqual([]);
  });
});
