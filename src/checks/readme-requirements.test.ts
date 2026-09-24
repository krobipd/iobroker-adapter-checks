import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readmeRequirementsCheck } from "./readme-requirements.js";

describe("readme-requirements", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "checks-req-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const readme = (body: string): void => writeFileSync(join(dir, "README.md"), body);
  const manifest = (deps: Record<string, string>[]): void =>
    writeFileSync(join(dir, "io-package.json"), JSON.stringify({ common: { dependencies: deps } }));
  const engines = (spec: string): void =>
    writeFileSync(join(dir, "package.json"), JSON.stringify({ engines: { node: spec } }));

  it("accepts matching requirements", () => {
    readme("## Requirements\n\n- **ioBroker js-controller >= 7.0.7**\n");
    manifest([{ "js-controller": ">=7.0.7" }]);
    expect(readmeRequirementsCheck.run(dir)).toEqual([]);
  });

  it("reports a README that promises an older version than the manifest requires", () => {
    readme("- **ioBroker js-controller >= 6.0.0**\n");
    manifest([{ "js-controller": ">=7.0.7" }]);
    const findings = readmeRequirementsCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("6.0.0");
    expect(findings[0]?.message).toContain("7.0.7");
  });

  it("names the direction: an older README refuses the install, a newer one sends users to upgrade (0.15.0)", () => {
    readme("- **ioBroker js-controller >= 6.0.0**\n");
    manifest([{ "js-controller": ">=7.0.7" }]);
    expect(readmeRequirementsCheck.run(dir)[0]?.impact).toContain("refuses");
    readme("- **ioBroker js-controller >= 7.10.0**\n");
    expect(readmeRequirementsCheck.run(dir)[0]?.impact).toContain("more than the adapter needs");
  });

  it("reads the list form as well as the bold form", () => {
    readme("- ioBroker admin >= 7.0.0\n");
    manifest([{ admin: ">=7.4.10" }]);
    expect(readmeRequirementsCheck.run(dir)[0]?.message).toContain("admin");
  });

  it("accepts the unicode greater-or-equal sign", () => {
    readme("- **ioBroker admin ≥ 7.4.10**\n");
    manifest([{ admin: ">=7.4.10" }]);
    expect(readmeRequirementsCheck.run(dir)).toEqual([]);
  });

  it("ignores a dependency the manifest does not declare", () => {
    readme("- **ioBroker vis-2 >= 2.0.0**\n");
    manifest([{ admin: ">=7.4.10" }]);
    expect(readmeRequirementsCheck.run(dir)).toEqual([]);
  });

  it("reports a Node version below what package.json requires", () => {
    readme("Requires Node.js >= 18\n");
    manifest([]);
    engines(">= 22");
    expect(readmeRequirementsCheck.run(dir)[0]?.message).toContain("Node.js");
  });

  it("accepts a README that asks for more Node than required", () => {
    readme("Requires Node.js >= 24\n");
    manifest([]);
    engines(">= 22");
    expect(readmeRequirementsCheck.run(dir)).toEqual([]);
  });

  it("stays silent without README or manifest", () => {
    expect(readmeRequirementsCheck.run(dir)).toEqual([]);
  });
});
