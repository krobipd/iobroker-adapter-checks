import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changelogCountCheck } from "./changelog-count.js";

describe("changelog-count", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "checks-changelog-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const readme = (body: string): void => writeFileSync(join(dir, "README.md"), body);
  const entries = (n: number): string =>
    Array.from({ length: n }, (_, i) => `### 1.${i}.0 (2026-01-01)\n- something\n`).join("\n");

  it("accepts seven entries", () => {
    readme(`## Changelog\n\n${entries(7)}\n## License\n`);
    expect(changelogCountCheck.run(dir)).toEqual([]);
  });

  it("reports eight entries and names the count", () => {
    readme(`## Changelog\n\n${entries(8)}\n## License\n`);
    const findings = changelogCountCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("8 versioned entries");
  });

  it("does not count the work-in-progress heading", () => {
    readme(`## Changelog\n\n### **WORK IN PROGRESS**\n- new stuff\n\n${entries(7)}\n## License\n`);
    expect(changelogCountCheck.run(dir)).toEqual([]);
  });

  it("stops counting at the next top-level section", () => {
    readme(`## Changelog\n\n${entries(3)}\n## License\n\n${entries(6)}`);
    expect(changelogCountCheck.run(dir)).toEqual([]);
  });

  it("stays silent when there is no changelog section", () => {
    readme("# Adapter\n\nno changelog here\n");
    expect(changelogCountCheck.run(dir)).toEqual([]);
  });

  it("stays silent when there is no README", () => {
    expect(changelogCountCheck.run(dir)).toEqual([]);
  });
});
