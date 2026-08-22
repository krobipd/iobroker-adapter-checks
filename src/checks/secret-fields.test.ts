import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { secretFieldsCheck } from "./secret-fields.js";

describe("secret-fields", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "checks-secret-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const iopkg = (obj: unknown): void =>
    writeFileSync(join(dir, "io-package.json"), JSON.stringify(obj));

  it("accepts the fields at the root", () => {
    iopkg({ common: { name: "x" }, encryptedNative: ["password"], protectedNative: ["password"] });
    expect(secretFieldsCheck.run(dir)).toEqual([]);
  });

  it("reports a field nested under common", () => {
    iopkg({ common: { name: "x", encryptedNative: ["password"] } });
    const findings = secretFieldsCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("encryptedNative");
  });

  it("reports both fields separately", () => {
    iopkg({ common: { encryptedNative: ["a"], protectedNative: ["a"] } });
    expect(secretFieldsCheck.run(dir)).toHaveLength(2);
  });

  it("accepts an adapter that has no secret settings at all", () => {
    iopkg({ common: { name: "x" } });
    expect(secretFieldsCheck.run(dir)).toEqual([]);
  });

  it("survives a manifest where common is not an object", () => {
    iopkg({ common: "oops" });
    expect(secretFieldsCheck.run(dir)).toEqual([]);
  });

  it("stays silent when io-package.json is missing or broken", () => {
    expect(secretFieldsCheck.run(dir)).toEqual([]);
    writeFileSync(join(dir, "io-package.json"), "{ not json");
    expect(secretFieldsCheck.run(dir)).toEqual([]);
  });
});
