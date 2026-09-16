import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchStubResponseCheck } from "./fetch-stub-response.js";

describe("fetch-stub-response", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fetch-stub-response-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel: string, text: string): void => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };

  /** The ai-usage unit test before the fix (2026-09-16): `body` missing, the stream path untested. */
  const AI_USAGE_UNIT = `
    import { vi } from "vitest";
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ a: 1 }), text: () => Promise.resolve("{}") }),
    );
    vi.stubGlobal("fetch", fetchMock);
  `;

  /** The ai-usage inventory fixture before the fix: a \`--require\` hook replacing the global. */
  const AI_USAGE_HOOK = `
    "use strict";
    globalThis.fetch = function (url) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ usage: 1 }),
        text: async () => JSON.stringify({ usage: 1 }),
      });
    };
  `;

  /** Both files after the fix: a real Response. */
  const FIXED_UNIT = `
    import { vi } from "vitest";
    const fetchMock = vi.fn(() => Promise.resolve(new Response(text, { status })));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
  `;
  const FIXED_HOOK = `
    globalThis.fetch = function () {
      return Promise.resolve(new Response(JSON.stringify({ usage: 1 }), { status: 200 }));
    };
  `;

  it("accepts stubs that answer with a real Response", () => {
    write("src/lib/http.test.ts", FIXED_UNIT);
    write("test/fixtures/inventory/fetch-hook.cjs", FIXED_HOOK);
    expect(fetchStubResponseCheck.run(dir)).toEqual([]);
  });

  it("reports the hand-built object in a vitest stub, at the json/text member lines", () => {
    write("src/lib/http.test.ts", AI_USAGE_UNIT);
    const findings = fetchStubResponseCheck.run(dir);
    expect(findings.map((f) => [f.file, f.line])).toEqual([
      ["src/lib/http.test.ts", 4],
      ["src/lib/http.test.ts", 4],
    ]);
    expect(findings[0].message).toContain("instead of a real Response");
    expect(findings[0].impact).toContain(
      "new Response(body, { status, headers })",
    );
  });

  it("reports the hand-built object in a .cjs fixture that replaces globalThis.fetch", () => {
    write("test/fixtures/inventory/fetch-hook.cjs", AI_USAGE_HOOK);
    const findings = fetchStubResponseCheck.run(dir);
    expect(findings.map((f) => [f.file, f.line])).toEqual([
      ["test/fixtures/inventory/fetch-hook.cjs", 7],
      ["test/fixtures/inventory/fetch-hook.cjs", 8],
    ]);
  });

  it("sees every stub form the fleet uses", () => {
    const literal = `{ ok: false, status: 500, headers: new Headers(), text: () => Promise.resolve("x") }`;
    const forms = [
      `vi.stubGlobal("fetch", vi.fn().mockResolvedValue(${literal}));`,
      `global.fetch = vi.fn(async () => (${literal}));`,
      `vi.spyOn(globalThis, "fetch").mockResolvedValue(${literal} as unknown as Response);`,
      `globalThis.fetch = (() => Promise.resolve(${literal})) as typeof fetch;`,
    ];
    forms.forEach((form, i) => write(`src/form${i}.test.ts`, form));
    expect(fetchStubResponseCheck.run(dir)).toHaveLength(forms.length);
  });

  it("sees method shorthand and vi.fn members too", () => {
    write(
      "src/a.test.ts",
      `vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, json() { return Promise.resolve({}); } }));`,
    );
    write(
      "src/b.test.ts",
      `vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, text: vi.fn().mockResolvedValue("") }));`,
    );
    write(
      "src/c.test.ts",
      `vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, json: async function () { return {}; } }));`,
    );
    expect(fetchStubResponseCheck.run(dir).map((f) => f.file)).toEqual([
      "src/a.test.ts",
      "src/b.test.ts",
      "src/c.test.ts",
    ]);
  });

  it("leaves files alone that do not stub fetch", () => {
    // A hand-built object is fine when it imitates something else (an HTTP client wrapper, a cheerio node).
    write(
      "src/client.test.ts",
      `const client = { json: () => Promise.resolve({}), text: () => Promise.resolve("") }; expect(parse(client)).toBe(1);`,
    );
    write(
      "test/integration.js",
      `const { tests } = require("@iobroker/testing"); tests.integration(__dirname);`,
    );
    expect(fetchStubResponseCheck.run(dir)).toEqual([]);
  });

  it("does not mistake data fields for response methods", () => {
    write(
      "src/i18n.test.ts",
      `vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
       const label = { text: "hello", json: '{"a":1}', textual: () => 1, tojson: () => 2 };`,
    );
    expect(fetchStubResponseCheck.run(dir)).toEqual([]);
  });

  it("does not read comments or a fetch stub mentioned only in a comment", () => {
    write(
      "src/doc.test.ts",
      `// vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: () => 1 }));
       /* text: () => Promise.resolve("") */
       const real = new Response("{}", { status: 200 });`,
    );
    expect(fetchStubResponseCheck.run(dir)).toEqual([]);
  });

  it("does not look at production sources or type declarations", () => {
    write(
      "src/main.ts",
      `globalThis.fetch = wrappedFetch; const r = { json: () => Promise.resolve({}) };`,
    );
    write(
      "test/types.d.ts",
      `declare const fetchMock: { json: () => Promise<unknown> }; globalThis.fetch = fetchMock;`,
    );
    expect(fetchStubResponseCheck.run(dir)).toEqual([]);
  });
});
