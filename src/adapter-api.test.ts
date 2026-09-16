import { describe, expect, it } from "vitest";
import { adapterCalls, laterOnSamePath, typescriptApi } from "./adapter-api.js";

describe("adapter-api", () => {
  it("loads the installed TypeScript compiler", () => {
    expect(typescriptApi()).toBeDefined();
  });

  it("lists calls with receiver, arguments and line", () => {
    const calls = adapterCalls(
      `const x = 1;\nawait this.adapter.delObjectAsync( id, { recursive: true } );\nfoo(bar);\n`,
      "a.ts",
    );
    expect(calls).toEqual([
      expect.objectContaining({
        name: "delObjectAsync",
        receiver: "this.adapter",
        onAdapter: true,
        args: ["id", "{ recursive: true }"],
        line: 2,
      }),
    ]);
  });

  it("knows the adapter: this inside a class extending …Adapter, adapter, ….adapter", () => {
    const calls = adapterCalls(
      `class Main extends utils.Adapter {
        async f() { await this.setStateAsync("a", 1); }
      }
      class Lib {
        constructor(private readonly adapter: ioBroker.Adapter) {}
        async g() { await this.setStateAsync("b", 1); await this.adapter.setStateAsync("c", 1); }
      }
      async function h(adapter: ioBroker.Adapter, ctx: { adapter: ioBroker.Adapter }) {
        await adapter.setStateAsync("d", 1);
        await ctx.adapter?.setStateAsync("e", 1);
        await ctx.port.setStateAsync("f", 1);
      }`,
      "a.ts",
    );
    expect(calls?.map((c) => [c.args[0], c.onAdapter])).toEqual([
      ['"a"', true],
      ['"b"', false],
      ['"c"', true],
      ['"d"', true],
      ['"e"', true],
      ['"f"', false],
    ]);
  });

  it("does not take a class extending something else for the adapter", () => {
    const calls = adapterCalls(
      `class Main extends EventEmitter { async f() { await this.setObject("a", {}); } }`,
      "a.ts",
    );
    expect(calls?.[0]?.onAdapter).toBe(false);
  });

  it("lists nothing for an empty file (undefined is reserved for a missing compiler)", () => {
    expect(adapterCalls("", "a.ts")).toEqual([]);
  });

  describe("laterOnSamePath", () => {
    const pair = (code: string): string | undefined => {
      const calls = adapterCalls(code, "a.ts") ?? [];
      const from = calls.find((c) => c.name === "delObjectAsync");
      if (!from) {
        throw new Error("no delete in the fixture");
      }
      return laterOnSamePath(calls, from, (c) => c.name === "extendObject")?.args[0];
    };

    it("finds the create that follows in the same block", () => {
      expect(pair(`async function f() { await a.delObjectAsync(id); await a.extendObject(id, {}); }`)).toBe("id");
    });

    it("finds a create nested in a later statement", () => {
      expect(
        pair(`async function f() { await a.delObjectAsync(id); try { await a.extendObject(id, {}); } catch {} }`),
      ).toBe("id");
    });

    it("finds the create after the try that holds the delete", () => {
      expect(
        pair(`async function f() { try { await a.delObjectAsync(id); } catch { return; } await a.extendObject(id, {}); }`),
      ).toBe("id");
    });

    it("stops at a return between them", () => {
      expect(
        pair(`async function f() {
          if (!ok) { try { await a.delObjectAsync(id); } catch {} return; }
          await a.extendObject(id, {});
        }`),
      ).toBeUndefined();
    });

    it("does not leave the function", () => {
      expect(
        pair(`async function f() { await a.delObjectAsync(id); }\nasync function g() { await a.extendObject(id, {}); }`),
      ).toBeUndefined();
    });

    it("does not look backwards", () => {
      expect(pair(`async function f() { await a.extendObject(id, {}); await a.delObjectAsync(id); }`)).toBeUndefined();
    });

    it("stays inside an arrow function body", () => {
      expect(
        pair(`ids.map(async (id) => { await a.delObjectAsync(id); await a.extendObject(id, {}); });`),
      ).toBe("id");
      expect(
        pair(`ids.map(async (id) => { await a.delObjectAsync(id); }); await a.extendObject(id, {});`),
      ).toBeUndefined();
    });
  });
});
