import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commonDocsCheck } from "./common-docs.js";

describe("common-docs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "common-docs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const page = (rel: string, text = "# Docs"): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };

  /** Manifest plus the pages a complete pair needs; `docs` undefined leaves the field out. */
  const setup = (
    docs: unknown,
    files: string[] = ["docs/en/README.md", "docs/de/README.md"],
  ): void => {
    const common: Record<string, unknown> = {};
    if (docs !== undefined) {
      common.docs = docs;
    }
    writeFileSync(join(dir, "io-package.json"), JSON.stringify({ common }));
    for (const rel of files) {
      page(rel);
    }
  };

  const messages = (): string[] =>
    commonDocsCheck.run(dir).map((f) => f.message);

  it("reports a manifest without the field", () => {
    setup(undefined);
    expect(messages().some((m) => m.includes("common.docs is missing"))).toBe(
      true,
    );
  });

  it("accepts a complete pair", () => {
    setup({ en: ["docs/en/README.md"], de: ["docs/de/README.md"] });
    expect(commonDocsCheck.run(dir)).toEqual([]);
  });

  it("accepts the plain-string form the schema allows", () => {
    setup({ en: "docs/en/README.md", de: "docs/de/README.md" });
    expect(commonDocsCheck.run(dir)).toEqual([]);
  });

  it("reports a missing required language", () => {
    setup({ en: ["docs/en/README.md"] });
    expect(messages().some((m) => m.includes("no 'de' entry"))).toBe(true);
  });

  it("reports a linked file that does not exist", () => {
    setup({
      en: ["docs/en/README.md", "docs/en/faq.md"],
      de: ["docs/de/README.md", "docs/de/faq.md"],
    });
    expect(messages().some((m) => m.includes("'docs/en/faq.md'"))).toBe(true);
  });

  it("demands the main page as the first entry", () => {
    page("docs/en/faq.md", "# FAQ");
    page("docs/de/faq.md", "# FAQ");
    setup({
      en: ["docs/en/faq.md", "docs/en/README.md"],
      de: ["docs/de/faq.md", "docs/de/README.md"],
    });
    expect(messages().some((m) => m.includes("must start with"))).toBe(true);
  });

  it("reports a page that lies in the folder but is not linked", () => {
    setup({ en: ["docs/en/README.md"], de: ["docs/de/README.md"] });
    page("docs/en/faq.md", "# FAQ");
    const findings = commonDocsCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("docs/en/faq.md");
    expect(findings[0]?.message).toContain("does not link it");
  });

  it("demands the same chapters in both languages", () => {
    page("docs/en/faq.md", "# FAQ");
    setup({
      en: ["docs/en/README.md", "docs/en/faq.md"],
      de: ["docs/de/README.md"],
    });
    expect(messages().some((m) => m.includes("carries the chapters"))).toBe(
      true,
    );
  });

  it("reports an entry that is neither a path nor a list", () => {
    setup({ en: 42, de: ["docs/de/README.md"] });
    expect(
      messages().some((m) => m.includes("neither a path nor a list")),
    ).toBe(true);
  });

  it("says nothing without a manifest", () => {
    expect(commonDocsCheck.run(dir)).toEqual([]);
  });
});
