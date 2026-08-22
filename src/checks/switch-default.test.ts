import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { switchDefaultCheck } from "./switch-default.js";

describe("switch-default", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "checks-switch-"));
    mkdirSync(join(dir, "src"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const src = (name: string, code: string): void => writeFileSync(join(dir, "src", name), code);

  it("accepts a dispatch that has a default branch", () => {
    src(
      "main.ts",
      `switch (obj.command) {
         case "a": return 1;
         default: return 0;
       }`,
    );
    expect(switchDefaultCheck.run(dir)).toEqual([]);
  });

  it("reports a dispatch without a default branch, with file and line", () => {
    src(
      "main.ts",
      `const x = 1;
       switch (obj.command) {
         case "a": return 1;
       }`,
    );
    const findings = switchDefaultCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("src/main.ts");
    expect(findings[0]?.line).toBe(2);
  });

  it("does not confuse a nested block's closing brace with the switch end", () => {
    src(
      "main.ts",
      `switch (obj.command) {
         case "a": { const y = 1; break; }
         default: break;
       }`,
    );
    expect(switchDefaultCheck.run(dir)).toEqual([]);
  });

  it("ignores a switch that is not over a command", () => {
    src("main.ts", `switch (state.val) { case 1: break; }`);
    expect(switchDefaultCheck.run(dir)).toEqual([]);
  });

  it("skips tests and type declarations", () => {
    src("main.test.ts", `switch (obj.command) { case "a": break; }`);
    src("types.d.ts", `switch (obj.command) { case "a": break; }`);
    expect(switchDefaultCheck.run(dir)).toEqual([]);
  });

  it("finds a dispatch in a nested source folder", () => {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(join(dir, "src", "lib", "msg.ts"), `switch (message.command) { case "a": break; }`);
    expect(switchDefaultCheck.run(dir)[0]?.file).toBe("src/lib/msg.ts");
  });

  it("returns nothing when the adapter has no src folder", () => {
    expect(switchDefaultCheck.run(join(dir, "does-not-exist"))).toEqual([]);
  });
});
