import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instanceEnabledCheck } from "./instance-enabled.js";

describe("instance-enabled", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "instance-enabled-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const manifest = (common: Record<string, unknown>): string[] => {
    writeFileSync(join(dir, "io-package.json"), JSON.stringify({ common }));
    return instanceEnabledCheck.run(dir).map((f) => f.message);
  };

  it("is silent without io-package.json", () => {
    expect(instanceEnabledCheck.run(dir)).toEqual([]);
  });

  it("accepts false", () => {
    expect(manifest({ enabled: false })).toEqual([]);
  });

  it("reports true", () => {
    expect(manifest({ enabled: true })).toEqual([
      "common.enabled is true — it should be false",
    ]);
  });

  it("reports a missing field — it is mandatory", () => {
    expect(manifest({ name: "demo" })).toEqual([
      "common.enabled is missing — it is mandatory and should be false",
    ]);
  });

  it("reports a value that is not a boolean", () => {
    expect(manifest({ enabled: "false" })).toEqual([
      'common.enabled is "false" — it should be false',
    ]);
  });
});
