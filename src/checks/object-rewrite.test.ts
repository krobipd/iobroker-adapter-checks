import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { objectRewriteCheck } from "./object-rewrite.js";

describe("object-rewrite", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "object-rewrite-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const adapter = (files: Record<string, string>): void => {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, "src", name), text);
    }
  };

  const messages = (): string[] => objectRewriteCheck.run(dir).map((f) => `${f.file}:${f.line ?? 0} ${f.message}`);

  /** The fleet form (govee-smart 2.38.0): read, change the copy, write it back whole under the full id. */
  const GOOD = `
    export class StateManager {
      constructor(private readonly adapter: ioBroker.Adapter) {}
      private async repairCommonStatesIfBuggy(id: string, fresh: Record<string, string>): Promise<void> {
        const existing = await this.adapter.getObjectAsync(id).catch(() => null);
        if (!existing) {
          return;
        }
        existing.common.states = fresh;
        const full = \`\${this.adapter.namespace}.\${id}\` as const;
        await this.adapter.setForeignObject(full, existing as ioBroker.SettableObject<ioBroker.StateObject>);
      }
      private async safeDeleteState(id: string): Promise<void> {
        await this.adapter.delStateAsync(id).catch(() => undefined);
        await this.adapter.delObjectAsync(id).catch(() => undefined);
      }
      async ensure(id: string, common: ioBroker.StateCommon): Promise<void> {
        await this.adapter.extendObject(id, { type: "state", common, native: {} });
      }
    }
  `;

  it("accepts the read-copy-setForeignObject form, a plain delete and a plain create", () => {
    adapter({ "lib/state-manager.ts": GOOD });
    expect(objectRewriteCheck.run(dir)).toEqual([]);
  });

  it("is silent without src/", () => {
    expect(objectRewriteCheck.run(dir)).toEqual([]);
  });

  describe("whole-object write", () => {
    it("reports setObjectAsync on the adapter class, with the line", () => {
      adapter({
        "main.ts": `
          class Hueemu extends utils.Adapter {
            private async dropClientsFolderType(): Promise<void> {
              const clients = await this.getObjectAsync("clients");
              const common = { ...clients.common };
              delete common.type;
              await this.setObjectAsync("clients", { ...clients, common });
            }
          }`,
      });
      const [finding] = objectRewriteCheck.run(dir);
      expect(finding).toMatchObject({ file: "src/main.ts", line: 7 });
      expect(finding?.message).toBe('the adapter writes an object whole with setObjectAsync("clients")');
      expect(finding?.impact).toContain("setForeignObject(`${namespace}.${id}`, copy)");
    });

    it("reports setObject and setObjectAsync through an adapter field", () => {
      adapter({
        "lib/state-manager.ts": `
          export class StateManager {
            constructor(private readonly adapter: ioBroker.Adapter) {}
            async a(id: string, existing: ioBroker.Object): Promise<void> { await this.adapter.setObjectAsync(id, existing); }
            async b(id: string, existing: ioBroker.Object): Promise<void> { await this.adapter.setObject(id, existing); }
          }`,
      });
      expect(messages()).toEqual([
        "src/lib/state-manager.ts:4 the adapter writes an object whole with setObjectAsync(id)",
        "src/lib/state-manager.ts:5 the adapter writes an object whole with setObject(id)",
      ]);
    });

    it("leaves a same-named method of another receiver alone", () => {
      adapter({
        "lib/cache.ts": `
          export class Cache {
            async put(id: string, value: unknown): Promise<void> {
              await this.store.setObject(id, value);
              await this.setObjectAsync(id, value);
            }
          }`,
      });
      expect(objectRewriteCheck.run(dir)).toEqual([]);
    });
  });

  describe("delete and create again", () => {
    it("reports the pair with both lines (hassemu object-repair)", () => {
      adapter({
        "lib/object-repair.ts": `
          export async function replaceObjectPreservingValue(adapter: RepairAdapter, id: string, prepared: ioBroker.SettableObject): Promise<void> {
            const prev = await adapter.getStateAsync(id);
            await adapter.delObjectAsync(id);
            try {
              await adapter.setObjectNotExistsAsync(id, prepared);
              if (prev && prev.val !== null && prev.val !== undefined) {
                await adapter.setState(id, { val: prev.val, ack: true });
              }
            } catch (err) {
              adapter.log.warn(String(err));
            }
          }`,
      });
      const [finding] = objectRewriteCheck.run(dir);
      expect(finding).toMatchObject({ file: "src/lib/object-repair.ts", line: 4 });
      expect(finding?.message).toBe(
        "the adapter deletes id with delObjectAsync and creates it again with setObjectNotExistsAsync (line 6)",
      );
      expect(finding?.impact).toContain("removes the id from every enum");
    });

    it("reports the pair inside a switch case (0.15.0)", () => {
      // tooling audit 2026-09-24 (P4): the walk climbed past the case clause and saw nothing
      adapter({
        "lib/migrate.ts": `
          export async function migrate(adapter: ioBroker.Adapter, id: string, kind: string, obj: ioBroker.SettableObject): Promise<void> {
            switch (kind) {
              case "old":
                await adapter.delObjectAsync(id);
                await adapter.setObjectNotExistsAsync(id, obj);
                break;
              default:
                break;
            }
          }`,
      });
      expect(messages()).toEqual([
        "src/lib/migrate.ts:5 the adapter deletes id with delObjectAsync and creates it again with setObjectNotExistsAsync (line 6)",
      ]);
    });

    it("a break between the delete and the create in another case is no pair", () => {
      adapter({
        "lib/migrate.ts": `
          export async function migrate(adapter: ioBroker.Adapter, id: string, kind: string, obj: ioBroker.SettableObject): Promise<void> {
            switch (kind) {
              case "gone":
                await adapter.delObjectAsync(id);
                break;
              case "new":
                await adapter.setObjectNotExistsAsync(id, obj);
                break;
            }
          }`,
      });
      expect(messages()).toEqual([]);
    });

    it("reports delete + extendObject after a try around the delete (yamaha 2.8.0 bounds)", () => {
      adapter({
        "main.ts": `
          class Yamaha extends utils.Adapter {
            private async dropBounds(id: string, object: ioBroker.StateObject): Promise<void> {
              const common = { ...object.common };
              delete common.min;
              try {
                await this.delObjectAsync(id, { recursive: false });
              } catch (e) {
                this.log.debug(String(e));
                return;
              }
              await this.extendObject(id, { type: "state", common, native: object.native });
            }
          }`,
      });
      expect(messages()).toEqual([
        "src/main.ts:7 the adapter deletes id with delObjectAsync and creates it again with extendObject (line 12)",
      ]);
    });

    it("does not pair a delete that returns with a create in a later branch", () => {
      adapter({
        "lib/client-registry.ts": `
          export class ClientRegistry {
            constructor(private readonly adapter: ioBroker.Adapter) {}
            async restoreOne(id: string, obj: ioBroker.Object): Promise<void> {
              if (!obj.native.cookie) {
                try {
                  await this.adapter.delObjectAsync(\`clients.\${id}\`, { recursive: true });
                } catch (err) {
                  this.adapter.log.debug(String(err));
                }
                return;
              }
              if (obj.type === "channel") {
                await this.adapter.extendObject(\`clients.\${id}\`, { type: "device" });
              }
            }
          }`,
      });
      expect(objectRewriteCheck.run(dir)).toEqual([]);
    });

    it("does not pair a move (different ids, either order) or a delete-only path", () => {
      adapter({
        "main.ts": `
          class Main extends utils.Adapter {
            async move(oldId: string, newId: string, obj: ioBroker.Object): Promise<void> {
              await this.setObjectNotExistsAsync(newId, obj);
              await this.delObjectAsync(oldId);
            }
            async moveBack(oldId: string, newId: string, obj: ioBroker.Object): Promise<void> {
              await this.delObjectAsync(oldId);
              await this.setObjectNotExistsAsync(newId, obj);
            }
            async drop(id: string): Promise<void> {
              await this.delObjectAsync(id, { recursive: true });
            }
          }`,
      });
      expect(objectRewriteCheck.run(dir)).toEqual([]);
    });

    it("does not pair calls on different receivers or in different functions", () => {
      adapter({
        "lib/x.ts": `
          export async function a(adapter: ioBroker.Adapter, other: ioBroker.Adapter, id: string): Promise<void> {
            await adapter.delObjectAsync(id);
            await other.setObjectNotExistsAsync(id, {});
          }
          export async function b(adapter: ioBroker.Adapter, id: string): Promise<void> {
            await adapter.delObjectAsync(id);
          }
          export async function c(adapter: ioBroker.Adapter, id: string): Promise<void> {
            await adapter.extendObject(id, {});
          }`,
      });
      expect(objectRewriteCheck.run(dir)).toEqual([]);
    });

    it("judges a port receiver too, and foreign objects", () => {
      adapter({
        "lib/sync.ts": `
          export class Sync {
            async fix(rel: string, obj: ioBroker.Object): Promise<void> {
              await this.port.delForeignObject(rel);
              await this.port.setForeignObjectNotExists(rel, obj);
            }
          }`,
      });
      expect(messages()).toEqual([
        "src/lib/sync.ts:4 the adapter deletes rel with delForeignObject and creates it again with setForeignObjectNotExists (line 5)",
      ]);
    });
  });
});

describe("object-rewrite without a compiler", () => {
  it("reports that the sources could not be judged instead of staying silent", async () => {
    vi.resetModules();
    vi.doMock("../adapter-api.js", () => ({
      adapterCalls: () => undefined,
      laterOnSamePath: () => undefined,
    }));
    const { objectRewriteCheck: check } = await import("./object-rewrite.js");
    const dir = mkdtempSync(join(tmpdir(), "object-rewrite-nocompiler-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "main.ts"), "export const x = 1;\n");
      const findings = check.run(dir);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("no `typescript` module can be loaded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.doUnmock("../adapter-api.js");
      vi.resetModules();
    }
  });
});
