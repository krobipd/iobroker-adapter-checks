import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  const readme = (body: string): void =>
    writeFileSync(join(dir, "README.md"), body);
  const manifest = (deps: Record<string, string>[]): void =>
    writeFileSync(
      join(dir, "io-package.json"),
      JSON.stringify({ common: { dependencies: deps } }),
    );
  const engines = (spec: string): void =>
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ engines: { node: spec } }),
    );

  const docsPage = (lang: string, body: string): void => {
    mkdirSync(join(dir, "docs", lang), { recursive: true });
    writeFileSync(join(dir, "docs", lang, "README.md"), body);
  };

  it("reads the user documentation too, in both forms (0.23.0)", () => {
    readme("- admin >= 8.0.14\n");
    manifest([{ admin: ">=8.0.14" }, { "js-controller": ">=7.2.2" }]);
    docsPage("en", "- js-controller 7.2.2 or newer\n- admin 8.0.11 or newer\n");
    docsPage(
      "de",
      "- ioBroker Admin 8.0.11 oder neuer\n- Admin >= 8.0.11, sonst nichts\n",
    );
    const findings = readmeRequirementsCheck.run(dir);
    expect(findings.map((f) => f.file)).toEqual([
      "docs/de/README.md",
      "docs/de/README.md",
      "docs/en/README.md",
    ]);
    expect(findings[2]?.message).toBe(
      "admin: docs/en/README.md says >= 8.0.11, the manifest requires >= 8.0.14",
    );
  });

  it("judges the Node.js line of a documentation page in both forms", () => {
    readme("- Node.js >= 22\n");
    manifest([]);
    engines(">=22");
    docsPage("en", "- Node.js 20 or newer\n");
    expect(readmeRequirementsCheck.run(dir).map((f) => f.message)).toEqual([
      "Node.js: docs/en/README.md says >= 20, package.json requires >= 22",
    ]);
    docsPage("en", "- Node.js 22 or newer\n");
    expect(readmeRequirementsCheck.run(dir)).toEqual([]);
  });

  it("does not read the Sentry sentence on a documentation page either", () => {
    readme("- js-controller >= 7.2.2\n");
    manifest([{ "js-controller": ">=7.2.2" }]);
    docsPage(
      "en",
      "- js-controller 7.2.2 or newer\n\nError reporting requires js-controller 3.0 or newer.\n",
    );
    expect(readmeRequirementsCheck.run(dir)).toEqual([]);
  });

  it("reads the `or newer` form in the README too, but never the Sentry sentence", () => {
    readme(
      "- admin 8.0.11 or newer\n\nError reporting requires js-controller 3.0 or newer.\n",
    );
    manifest([{ admin: ">=8.0.14" }, { "js-controller": ">=7.2.2" }]);
    expect(readmeRequirementsCheck.run(dir).map((f) => f.message)).toEqual([
      "admin: README says >= 8.0.11, the manifest requires >= 8.0.14",
    ]);
  });

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
    expect(readmeRequirementsCheck.run(dir)[0]?.impact).toContain(
      "more than the adapter needs",
    );
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

  it("reads a statement without the ioBroker prefix and with text after it (0.22.0, yamaha 523d891)", () => {
    const globalDeps = (deps: Record<string, string>[]): void =>
      writeFileSync(
        join(dir, "io-package.json"),
        JSON.stringify({ common: { globalDependencies: deps } }),
      );
    globalDeps([{ admin: ">=8.0.14" }]);
    for (const body of [
      "- admin >= 8.0.11\n",
      "- Admin >= 8.0.11 (the sign-in panel in the settings needs Admin 8)\n",
      "The adapter needs ioBroker admin ≥ 8.0.11 or newer.\n",
    ]) {
      readme(body);
      const findings = readmeRequirementsCheck.run(dir);
      expect(findings, body).toHaveLength(1);
      expect(findings[0]?.message).toBe(
        "admin: README says >= 8.0.11, the manifest requires >= 8.0.14",
      );
    }
  });

  it("judges every statement, not only the last one per name", () => {
    readme(
      "- ioBroker admin >= 8.0.11\n\nSee below: admin >= 8.0.14 is enough.\n",
    );
    manifest([{ admin: ">=8.0.14" }]);
    expect(readmeRequirementsCheck.run(dir)).toHaveLength(1);
  });

  it("leaves the changelog alone — its entries are history, not a promise", () => {
    readme(
      "- admin >= 8.0.14\n\n## Changelog\n\n### 1.0.0\n- (x) Adapter requires admin >= 7.7.22 now\n",
    );
    manifest([{ admin: ">=8.0.14" }]);
    expect(readmeRequirementsCheck.run(dir)).toEqual([]);
  });

  it("stays silent without README or manifest", () => {
    expect(readmeRequirementsCheck.run(dir)).toEqual([]);
  });
  it("reports a requirement stated outside the requirements section (tool round 87)", () => {
    manifest([{ admin: ">=8.0.14" }]);
    readme(
      "# demo\n\n## Requirements\n\n- ioBroker Admin >= 8.0.14\n\n## Configuration\n\n" +
        "> The settings card is an Admin-8 component, so this adapter requires Admin 8.\n\n" +
        "## Sentry\n\nError reporting requires js-controller 3.0 or newer.\n\n## Changelog\n\n- Adapter requires admin >= 8.0.14 now\n",
    );
    const findings = readmeRequirementsCheck.run(dir);
    expect(findings.map((f) => f.message)).toEqual([
      'README line 9: "The settings card is an Admin-8 component, so this adapter requires Admin 8." states a requirement outside the requirements section',
    ]);
  });

  it("keeps sub-headings of the requirements section inside it and leaves pages without one alone", () => {
    manifest([{ admin: ">=8.0.14" }]);
    readme(
      "## Requirements\n\n### Platform\n\n- Admin >= 8.0.14\n\n## Usage\n\nPress the button.\n",
    );
    expect(readmeRequirementsCheck.run(dir)).toEqual([]);
    readme("## Usage\n\n- Admin >= 8.0.14\n");
    expect(readmeRequirementsCheck.run(dir)).toEqual([]);
  });

  it("reports a platform requirement outside the section even when the manifest does not name it", () => {
    manifest([{ admin: ">=8.0.14" }]);
    readme("## Requirements\n\n- Admin >= 8.0.14\n\n## Install\n\nThis adapter needs Node.js 22.\n");
    expect(readmeRequirementsCheck.run(dir).map((f) => f.message)).toEqual([
      'README line 7: "This adapter needs Node.js 22." states a requirement outside the requirements section',
    ]);
  });
});
