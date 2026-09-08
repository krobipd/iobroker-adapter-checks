import { describe, expect, it } from "vitest";
import { stripYamlComments } from "./util.js";

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
