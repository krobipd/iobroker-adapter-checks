import { describe, expect, it } from "vitest";
import { stripTsComments, stripYamlComments } from "./util.js";

describe("stripYamlComments", () => {
  it("drops comment lines and trailing comments but keeps the line count", () => {
    const lines = stripYamlComments("a: 1\n# whole line\nb: 2 # trailing\n");
    expect(lines).toEqual(["a: 1", "", "b: 2", ""]);
  });

  it("keeps a # that is not preceded by whitespace", () => {
    expect(stripYamlComments("run: echo ${VALUE#>=}")).toEqual([
      "run: echo ${VALUE#>=}",
    ]);
    expect(stripYamlComments("if: startsWith(github.ref, 'refs/tags/#')")).toEqual([
      "if: startsWith(github.ref, 'refs/tags/#')",
    ]);
  });

  it("splits CRLF files line by line", () => {
    expect(stripYamlComments("a: 1\r\n# c\r\nb: 2\r\n")).toEqual([
      "a: 1",
      "",
      "b: 2",
      "",
    ]);
  });

  it("keeps line numbering so a finding can point at the original line", () => {
    const text = "one\n# two\nthree # x\nfour";
    const lines = stripYamlComments(text);
    expect(lines).toHaveLength(text.split("\n").length);
    expect(lines[2]).toBe("three");
  });
});

describe("stripTsComments", () => {
  it("removes line comments up to the end of the line", () => {
    expect(stripTsComments("const a = 1; // note\nconst b = 2;")).toBe(
      "const a = 1; \nconst b = 2;",
    );
  });

  it("removes block comments but keeps their newlines, so line numbers survive", () => {
    const text = "one\n/* two\nthree */ four\nfive";
    const out = stripTsComments(text);
    expect(out.split("\n")).toHaveLength(4);
    expect(out).toBe("one\n\n four\nfive");
  });

  it("does not treat a // inside a block comment as the start of a second cut", () => {
    expect(stripTsComments("a /* x // y */ b")).toBe("a  b");
  });

  it("leaves code without comments untouched", () => {
    const text = 'const url = "x";\nif (a) {\n  b();\n}\n';
    expect(stripTsComments(text)).toBe(text);
  });
});

describe("listSourceFiles", () => {
  it("lists src/**/*.ts without tests and declarations, and src-admin/src only on request", async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { listSourceFiles } = await import("./util.js");
    const dir = mkdtempSync(join(tmpdir(), "list-source-files-"));
    try {
      mkdirSync(join(dir, "src", "lib"), { recursive: true });
      mkdirSync(join(dir, "src-admin", "src"), { recursive: true });
      for (const f of ["src/main.ts", "src/lib/a.ts", "src/lib/a.test.ts", "src/types.d.ts", "src/x.tsx"]) {
        writeFileSync(join(dir, f), "");
      }
      for (const f of ["App.tsx", "rows.ts", "rows.test.ts", "App.test.tsx", "env.d.ts"]) {
        writeFileSync(join(dir, "src-admin", "src", f), "");
      }
      const rel = (files: string[]): string[] => files.map((f) => f.slice(dir.length + 1));
      expect(rel(listSourceFiles(dir))).toEqual(["src/lib/a.ts", "src/main.ts"]);
      expect(rel(listSourceFiles(dir, { admin: true }))).toEqual([
        "src/lib/a.ts",
        "src/main.ts",
        "src-admin/src/App.tsx",
        "src-admin/src/rows.ts",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
