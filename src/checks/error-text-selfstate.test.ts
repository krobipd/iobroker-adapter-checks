import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorTextSelfStateCheck } from "./error-text-selfstate.js";

describe("error-text-selfstate", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "errtext-"));
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const src = (body: string, name = "src/lib/main.ts"): void => {
    writeFileSync(join(dir, name), body);
  };

  it("says nothing without a src directory", () => {
    rmSync(join(dir, "src"), { recursive: true, force: true });
    expect(errorTextSelfStateCheck.run(dir)).toEqual([]);
  });

  it("accepts an empty reason", () => {
    src('await this.setState("info.error", { val: "", ack: true });\n');
    expect(errorTextSelfStateCheck.run(dir)).toEqual([]);
  });

  it("accepts a real failure text", () => {
    src('await this.setState("info.error", { val: err.message, ack: true });\n');
    expect(errorTextSelfStateCheck.run(dir)).toEqual([]);
  });

  it("reports a text that restates the run state", () => {
    src('await this.setState("info.error", { val: "Adapter is stopped", ack: true });\n');
    const f = errorTextSelfStateCheck.run(dir);
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(1);
    expect(f[0].file).toBe("src/lib/main.ts");
  });

  it("also catches an appended justification", () => {
    src('setState("info.error", "instance not running — nothing is being read");\n');
    expect(errorTextSelfStateCheck.run(dir)).toHaveLength(1);
  });

  it("ignores test files", () => {
    src('setState("info.error", "adapter is stopped");\n', "src/lib/main.test.ts");
    expect(errorTextSelfStateCheck.run(dir)).toEqual([]);
  });

  it("does not fire on an unrelated state", () => {
    src('setState("info.connection", { val: "adapter is stopped", ack: true });\n');
    expect(errorTextSelfStateCheck.run(dir)).toEqual([]);
  });
});
