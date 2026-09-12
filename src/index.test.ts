import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allChecks, runChecks } from "./index.js";

/**
 * A check file that is not wired into `allChecks` never runs anywhere — every adapter's
 * standards suite iterates `allChecks`, nothing else. The id doubles as the file name, which
 * is what tooling on the consumer side reads to know which checks this package ships.
 */
describe("wiring", () => {
  const files = readdirSync(join(__dirname, "checks"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => name.replace(/\.ts$/, ""))
    .sort();

  it("ships every check file in allChecks, under its file name as id", () => {
    expect([...allChecks.map((c) => c.id)].sort()).toEqual(files);
  });

  it("has no duplicate ids", () => {
    expect(new Set(allChecks.map((c) => c.id)).size).toBe(allChecks.length);
  });

  it("runs every check through runChecks and honours skip", () => {
    const all = allChecks.map((c) => c.id);
    const seen = new Set(runChecks(join(__dirname, "..")).map((f) => f.check));
    for (const id of seen) {
      expect(all).toContain(id);
    }
    expect(runChecks(join(__dirname, ".."), { skip: all })).toEqual([]);
  });
});
