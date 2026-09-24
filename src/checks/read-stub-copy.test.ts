import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStubCopyCheck } from "./read-stub-copy.js";

describe("read-stub-copy", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "read-stub-copy-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel: string, text: string): void => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };

  const run = (): Array<[number, string]> =>
    readStubCopyCheck
      .run(dir)
      .map((f) => [f.line ?? 0, f.message.replace(/^the stub of /, "")]);

  /** The hassemu harness before the fix (2026-09-17): the stored object itself. */
  const HASSEMU_BEFORE = `
    const store = { objects: new Map<string, object>(), states: new Map<string, object>() };
    const adapter = {
      getObjectAsync: (id: string) => {
        const fullId = id.startsWith("hassemu.0.") ? id : "hassemu.0." + id;
        const obj = store.objects.get(fullId);
        return Promise.resolve(obj ?? null);
      },
      getStateAsync: (id: string) => Promise.resolve(store.states.get(id) ?? null),
      setObject: (id: string, obj: object) => {
        store.objects.set(id, obj);
        return Promise.resolve();
      },
    };
  `;

  /** The same harness after the fix: a copy per read, null stays null. */
  const HASSEMU_AFTER = `
    const store = { objects: new Map<string, object>(), states: new Map<string, object>() };
    const adapter = {
      getObjectAsync: (id: string) => {
        const fullId = id.startsWith("hassemu.0.") ? id : "hassemu.0." + id;
        const obj = store.objects.get(fullId);
        return Promise.resolve(obj ? structuredClone(obj) : null);
      },
      getStateAsync: (id: string) => Promise.resolve(JSON.parse(JSON.stringify(store.states.get(id) ?? null))),
      getEnumsAsync: () => Promise.resolve(structuredClone(enums)),
      getForeignObjectsAsync: () => Promise.resolve(structuredClone(Object.fromEntries(store.objects))),
      setObject: (id: string, obj: object) => {
        store.objects.set(id, obj);
        return Promise.resolve();
      },
    };
  `;

  it("accepts a harness that answers every read with a copy", () => {
    write("src/lib/registry.test.ts", HASSEMU_AFTER);
    expect(run()).toEqual([]);
  });

  it("a shallow copy of an OBJECT still shares common/native; of a state it is a copy (0.15.0)", () => {
    // tooling audit 2026-09-24 (P8)
    write(
      "src/lib/shallow.test.ts",
      `
      const objects = new Map<string, ioBroker.Object>();
      const states = new Map<string, ioBroker.State>();
      const adapter = {
        getObjectAsync: (id: string) => Promise.resolve({ ...objects.get(id) }),
        getForeignObjectAsync: (id: string) => Promise.resolve(Object.assign({}, objects.get(id))),
        getStateAsync: (id: string) => Promise.resolve({ ...states.get(id) }),
        setState: () => Promise.resolve(),
      };
    `,
    );
    expect(run()).toEqual([
      [5, "getObjectAsync answers with the object it keeps (objects.get(id)) instead of a copy"],
      [6, "getForeignObjectAsync answers with the object it keeps (objects.get(id)) instead of a copy"],
    ]);
  });

  it("a member of a built OBJECT that is a kept object hands it out; built members and state reads do not (0.18.0)", () => {
    // fakeroku audit 2026-09-24: `{ common: this.instanceCommon, native: this.instanceNative }` and
    // `{ native: { devices: stored } }` passed, because only spread members were judged.
    write(
      "src/lib/members.test.ts",
      `
      const stored: Record<string, unknown> = {};
      class Harness {
        instanceCommon = { name: "x" };
        getForeignObjectAsync(id: string) {
          return Promise.resolve({ common: this.instanceCommon });
        }
      }
      function make(native: Record<string, unknown>) {
        return {
          getObjectAsync: () => Promise.resolve({ native: { devices: stored } }),
          getForeignObjectAsync: () => Promise.resolve({ native }),
          getEnumAsync: () => Promise.resolve({ result: { common: { name: "built" }, native: { port: 1 } } }),
          getStateAsync: () => Promise.resolve({ val: stored, ack: true }),
          setState: () => Promise.resolve(),
        };
      }
    `,
    );
    expect(run()).toEqual([
      [6, "getForeignObjectAsync answers with the object it keeps (this.instanceCommon) instead of a copy"],
      [11, "getObjectAsync answers with the object it keeps (stored) instead of a copy"],
      [12, "getForeignObjectAsync answers with the object it keeps (native) instead of a copy"],
    ]);
  });

  it("reports the lookup behind a variable and a direct lookup", () => {
    write("src/lib/registry.test.ts", HASSEMU_BEFORE);
    expect(run()).toEqual([
      [
        6,
        "getObjectAsync answers with the object it keeps (store.objects.get(fullId)) instead of a copy",
      ],
      [
        9,
        "getStateAsync answers with the object it keeps (store.states.get(id)) instead of a copy",
      ],
    ]);
  });

  it("sees the class harness, vi.fn wrappers, element lookups and kept members", () => {
    write(
      "src/main.test.ts",
      `
      import { vi } from "vitest";
      const existingObjects: Record<string, object> = {};
      class FakeAdapter {
        private objects = new Map<string, object>();
        private instanceObject = { native: {} };
        public getForeignObjectAsync = vi.fn((id: string) => Promise.resolve(this.objects.get(id) ?? null));
        public getObjectAsync = vi.fn((id: string) => existingObjects[id] ?? null);
        public getStateAsync = vi.fn(() => Promise.resolve(null));
        public getForeignStateAsync = vi.fn(() => Promise.resolve({ val: 1, ack: true }));
        public getForeignObjectsAsync = vi.fn(async () => Promise.resolve(this.instanceObject));
        public getStatesAsync = vi.fn(() => {
          const out: Record<string, object> = {};
          for (const [k, v] of this.objects) out[k] = structuredClone(v);
          return Promise.resolve(out);
        });
        getEnumsAsync() {
          return this.enums;
        }
      }
      `,
    );
    expect(run()).toEqual([
      [
        7,
        "getForeignObjectAsync answers with the object it keeps (this.objects.get(id)) instead of a copy",
      ],
      [
        8,
        "getObjectAsync answers with the object it keeps (existingObjects[id]) instead of a copy",
      ],
      [
        11,
        "getForeignObjectsAsync answers with the object it keeps (this.instanceObject) instead of a copy",
      ],
      [
        18,
        "getEnumsAsync answers with the object it keeps (this.enums) instead of a copy",
      ],
    ]);
  });

  it("follows assignments, spies and mock values, and reads a .cjs hook", () => {
    write(
      "src/lib/x.test.ts",
      `
      import { vi } from "vitest";
      const fixture = { type: "state", common: {} };
      const objects = new Map<string, object>();
      const adapter = makeAdapter();
      (adapter as { getObjectAsync: unknown }).getObjectAsync = async (id: string) => objects.get(id);
      adapter.getForeignObjectAsync = () => Promise.resolve(null);
      vi.spyOn(adapter, "getStateAsync").mockResolvedValue(fixture);
      vi.spyOn(adapter, "getForeignStateAsync").mockResolvedValueOnce({ val: 1 });
      adapter.getObjectAsync.mockResolvedValueOnce(structuredClone(fixture));
      adapter.getForeignObjectsAsync.mockImplementation(() => Promise.resolve(objects));
      adapter.getEnumAsync = vi.fn().mockReturnValue(fixture).mockResolvedValueOnce(null);
      adapter.getObjectViewAsync = readView;
      function readView() {
        return { rows: [] };
      }
      `,
    );
    write(
      "test/inventory-hook.cjs",
      `
      const objects = {};
      module.exports = { getObjectAsync: (id) => objects[id], getStateAsync: (id) => ({ val: objects[id] }) };
      `,
    );
    expect(run()).toEqual([
      [
        6,
        "getObjectAsync answers with the object it keeps (objects.get(id)) instead of a copy",
      ],
      [
        8,
        "getStateAsync answers with the object it keeps (fixture) instead of a copy",
      ],
      [
        11,
        "getForeignObjectsAsync answers with the object it keeps (objects) instead of a copy",
      ],
      [
        12,
        "getEnumAsync answers with the object it keeps (fixture) instead of a copy",
      ],
      [
        3,
        "getObjectAsync answers with the object it keeps (objects[id]) instead of a copy",
      ],
    ]);
  });

  it("does not judge the write side, parameters, other members or an empty adapter", () => {
    write(
      "src/lib/y.test.ts",
      `
      const store = new Map<string, object>();
      const adapter = {
        setObjectAsync: (id: string, obj: object) => Promise.resolve(store.set(id, obj)),
        getObjectAsync: (id: string, given: object) => Promise.resolve(given),
        readObject: (id: string) => store.get(id),
        getStateAsync: (id: string) => Promise.resolve(id ? { val: store.get(id) } : undefined),
      };
      `,
    );
    expect(run()).toEqual([]);
    rmSync(join(dir, "src"), { recursive: true, force: true });
    expect(readStubCopyCheck.run(dir)).toEqual([]);
  });

  it("judges a callback-form name only on an adapter surface", () => {
    write(
      "src/lib/scope-options.test.ts",
      `
      const data = { states: { DE: { BY: "Bavaria" } } };
      function makeFakeHd() {
        return { getCountries: () => data.countries ?? {}, getStates: (c: string) => data.states?.[c] };
      }
      const adapter = { namespace: "demo.0", getStates: () => Promise.resolve(data.states) };
      class Fake {
        getObject(id: string) {
          return this.objects.get(id);
        }
        setState() {}
      }
      const client = { getObject: (id: string) => cache[id], connect: () => {} };
      fakeAdapter.getObject = (id: string) => cache[id];
      client.getObject = (id: string) => cache[id];
      vi.spyOn(harness.adapter, "getState").mockReturnValue(fixture);
      vi.spyOn(client, "getState").mockReturnValue(fixture);
      `,
    );
    expect(run()).toEqual([
      [
        6,
        "getStates answers with the object it keeps (data.states) instead of a copy",
      ],
      [
        9,
        "getObject answers with the object it keeps (this.objects.get(id)) instead of a copy",
      ],
      [
        14,
        "getObject answers with the object it keeps (cache[id]) instead of a copy",
      ],
      [
        16,
        "getState answers with the object it keeps (fixture) instead of a copy",
      ],
    ]);
  });

  it("resolves an identifier through the file key the sources are parsed under", () => {
    // The 0.13.0 tag run crashed on Windows: `source.fileName` is normalised to forward slashes
    // by the compiler, the sources map is keyed by the listed path — the lookup missed.
    write(
      "src/lib/z.test.ts",
      `
      const objects = new Map<string, object>();
      adapter.getObjectAsync = readObject;
      function readObject(id: string) {
        return objects.get(id) ?? null;
      }
      `,
    );
    expect(run()).toEqual([
      [
        5,
        "getObjectAsync answers with the object it keeps (objects.get(id)) instead of a copy",
      ],
    ]);
  });

  it("names the check, file and impact in a finding", () => {
    write("src/lib/registry.test.ts", HASSEMU_BEFORE);
    const [first] = readStubCopyCheck.run(dir);
    expect(first).toMatchObject({
      check: "read-stub-copy",
      file: "src/lib/registry.test.ts",
      line: 6,
    });
    expect(first?.impact).toContain("structuredClone(obj)");
  });
});
