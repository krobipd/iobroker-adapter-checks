import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lowestAdmitted, overrideBelowParentCheck } from "./override-below-parent.js";

describe("override-below-parent", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "override-below-parent-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (overrides: unknown, packages?: Record<string, unknown>): void => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "iobroker.demo", overrides }));
    if (packages) {
      writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
    }
  };
  const run = (): string[] => overrideBelowParentCheck.run(dir).map((f) => `${f.file}: ${f.message}`);

  /** The fleet on 2026-09-24: mocha 12 declares diff ^9, the mocha-11 era override installs 8.0.4. */
  const FLEET = {
    "": { name: "iobroker.demo" },
    "node_modules/mocha": { version: "12.0.2", dependencies: { diff: "^9.0.0", "serialize-javascript": "^7.1.1" } },
    "node_modules/diff": { version: "8.0.4" },
    "node_modules/serialize-javascript": { version: "7.1.1" },
  };

  it("reports the measured fleet case: the override holds diff below what mocha 12 declares", () => {
    write({ mocha: { diff: "^8.0.3", "serialize-javascript": "^7.0.5" } }, FLEET);
    expect(run()).toEqual([
      "package.json: `overrides` installs diff 8.0.4, below the ^9.0.0 that mocha@12.0.2 declares",
    ]);
  });

  it("accepts an override that lifts a dependency above its dependant's range (a security floor)", () => {
    write(
      { esbuild: ">=0.25.0", "oauth2-server": { "type-is": "2.0.1" } },
      {
        "": {},
        "node_modules/vite": { version: "7.0.0", dependencies: { esbuild: "^0.24.0" } },
        "node_modules/esbuild": { version: "0.25.9" },
        "node_modules/oauth2-server": { version: "3.1.1", dependencies: { "type-is": "1.6.18" } },
        "node_modules/oauth2-server/node_modules/type-is": { version: "2.0.1" },
      },
    );
    expect(run()).toEqual([]);
  });

  it("resolves the instance node loads: nested first, then each enclosing node_modules", () => {
    write(
      { diff: "^8.0.3" },
      {
        "": {},
        "node_modules/a": { version: "1.0.0", dependencies: { diff: "^9.0.0" } },
        "node_modules/a/node_modules/diff": { version: "9.0.0" },
        "node_modules/b": { version: "1.0.0" },
        "node_modules/b/node_modules/c": { version: "2.0.0", dependencies: { diff: "^9.0.0" } },
        "node_modules/e": { version: "1.0.0" },
        "node_modules/e/node_modules/d": { version: "3.0.0", dependencies: { diff: "^9.1.0" } },
        "node_modules/e/node_modules/diff": { version: "9.1.0" },
        "node_modules/diff": { version: "8.0.4" },
      },
    );
    expect(run()).toEqual(["package.json: `overrides` installs diff 8.0.4, below the ^9.0.0 that c@2.0.0 declares"]);
  });

  it("reads the package name out of a `name@range` override key", () => {
    write(
      { "diff@<9": "8.0.4" },
      { "": {}, "node_modules/mocha": { version: "12.0.2", dependencies: { diff: "^9.0.0" } }, "node_modules/diff": { version: "8.0.4" } },
    );
    expect(run()).toEqual(["package.json: `overrides` installs diff 8.0.4, below the ^9.0.0 that mocha@12.0.2 declares"]);
  });

  it("judges only names the overrides touch, only installed packages, never the adapter's own ranges", () => {
    write(
      { "other@1": { x: "1.0.0" } },
      {
        "": { dependencies: { x: "^2.0.0" }, devDependencies: { diff: "^9.0.0" } },
        "node_modules/mocha": { version: "12.0.2", dependencies: { diff: "^9.0.0", x: "^2.0.0" } },
        "node_modules/diff": { version: "8.0.4" },
        "node_modules/x": { version: "1.0.0" },
      },
    );
    expect(run()).toEqual(["package.json: `overrides` installs x 1.0.0, below the ^2.0.0 that mocha@12.0.2 declares"]);
  });

  it("is silent without overrides and says so when the lockfile is missing", () => {
    write(undefined, FLEET);
    expect(run()).toEqual([]);
    write({}, FLEET);
    expect(run()).toEqual([]);
    rmSync(join(dir, "package-lock.json"));
    write({ mocha: { diff: "^8.0.3" } });
    expect(run()).toEqual([
      "package-lock.json: package.json carries `overrides`, but package-lock.json is missing, unreadable or has no `packages`",
    ]);
  });

  it("reads the lowest version a range admits", () => {
    expect(lowestAdmitted("^9.0.0")).toEqual([9, 0, 0]);
    expect(lowestAdmitted("~1.2.3")).toEqual([1, 2, 3]);
    expect(lowestAdmitted(">=1.2.0 <2")).toEqual([1, 2, 0]);
    expect(lowestAdmitted("1.2.3 - 2.3.4")).toEqual([1, 2, 3]);
    expect(lowestAdmitted("^7 || ^9.1")).toEqual([7, 0, 0]);
    expect(lowestAdmitted("<3")).toEqual([0, 0, 0]);
    expect(lowestAdmitted("*")).toEqual([0, 0, 0]);
    expect(lowestAdmitted("1.x")).toEqual([1, 0, 0]);
    expect(lowestAdmitted("npm:other@^1")).toBeUndefined();
    expect(lowestAdmitted("file:../x")).toBeUndefined();
    expect(lowestAdmitted("latest")).toBeUndefined();
  });
});
