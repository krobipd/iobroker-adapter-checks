import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { objectDeleteDropsStateCheck } from "./object-delete-drops-state.js";

describe("object-delete-drops-state", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "object-delete-drops-state-"));
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

  const lines = (): string[] =>
    objectDeleteDropsStateCheck.run(dir).map((f) => `${f.file}:${f.line ?? 0} ${f.message}`);

  it("is silent without src/", () => {
    expect(objectDeleteDropsStateCheck.run(dir)).toEqual([]);
  });

  it("reports delState before delObject of the same id (ioBroker.javascript) and after it (govee-smart 2.38.2), at the state delete", () => {
    adapter({
      "main.ts": `
        class Javascript extends utils.Adapter {
          private async onObjectChange(id: string): Promise<void> {
            const idActive = \`scriptEnabled.\${id}\`;
            await this.delStateAsync(idActive);
            await this.delObjectAsync(idActive);
          }
        }
      `,
      "lib/state-manager.ts": `
        export class StateManager {
          constructor(private readonly adapter: ioBroker.Adapter) {}
          private async safeDeleteState(id: string): Promise<void> {
            await this.adapter.delObjectAsync(id).catch(() => undefined);
            await this.adapter.delStateAsync(id).catch(() => undefined);
          }
        }
      `,
    });
    expect(lines()).toEqual([
      "src/lib/state-manager.ts:6 the adapter deletes the state id with delStateAsync beside delObjectAsync(id) (line 5)",
      "src/main.ts:5 the adapter deletes the state idActive with delStateAsync beside delObjectAsync(idActive) (line 6)",
    ]);
    const finding = objectDeleteDropsStateCheck.run(dir)[0];
    expect(finding?.impact).toContain("`_delForeignObject`");
  });

  it("pairs the callback forms too, foreign and own, on the same path through the function", () => {
    adapter({
      "main.ts": `
        class Adapter extends utils.Adapter {
          private cleanup(full: string): void {
            try {
              this.delForeignObject(full, () => undefined);
            } catch {
              // ignore
            }
            this.delForeignState(full, () => undefined);
          }
        }
      `,
    });
    expect(lines()).toEqual([
      "src/main.ts:9 the adapter deletes the state full with delForeignState beside delForeignObject(full) (line 5)",
    ]);
  });

  it("does not pair a delState on its own, a different id, a different receiver, a return between the two, or a port that is not the adapter", () => {
    adapter({
      "main.ts": `
        class Adapter extends utils.Adapter {
          private async orphans(id: string, other: string): Promise<void> {
            await this.delStateAsync(id);
            await this.delObjectAsync(other);
          }
          private async guarded(id: string): Promise<void> {
            const obj = await this.getObjectAsync(id);
            if (!obj) {
              await this.delStateAsync(id);
              return;
            }
            await this.delObjectAsync(id);
          }
          private async twoReceivers(id: string): Promise<void> {
            await this.delStateAsync(id);
            await this.objects.delObject(id);
          }
        }
        class Port {
          async remove(id: string): Promise<void> {
            await this.delState(id);
            await this.delObject(id);
          }
        }
      `,
      "lib/sandbox.ts": `
        export function deleteState(adapter: ioBroker.Adapter, id: string): void {
          adapter.delForeignState(id, function (err) {
            if (err) {
              adapter.log.warn(String(err));
            }
          });
        }
      `,
    });
    expect(lines()).toEqual([]);
  });

  it("reports that the sources could not be judged instead of staying silent", async () => {
    adapter({ "main.ts": "export const x = 1;\n" });
    vi.resetModules();
    vi.doMock("../adapter-api.js", async () => {
      const real = await vi.importActual<typeof import("../adapter-api.js")>("../adapter-api.js");
      return { ...real, adapterCalls: () => undefined };
    });
    const { objectDeleteDropsStateCheck: check } = await import("./object-delete-drops-state.js");
    const findings = check.run(dir);
    vi.doUnmock("../adapter-api.js");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("could not be parsed");
  });
});
