import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deprecatedAdapterMethodsCheck } from "./deprecated-adapter-methods.js";

describe("deprecated-adapter-methods", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deprecated-adapter-methods-"));
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** An installed `@iobroker/types` — the declaration forms of 7.2.2, cut down. */
  const TYPES = `
    declare global {
      namespace ioBroker {
        interface Adapter {
          /**
           * Extends an object in the object db
           *
           * @deprecated use \`adapter.extendObject\` without a callback instead
           */
          extendObjectAsync<T extends string>(id: T, objPart: ioBroker.PartialObject, options?: unknown): ioBroker.SetObjectPromise;
          /** Writes a value into the states DB.
           * @deprecated use \`adapter.setState\` without callback instead */
          setStateAsync(id: string, state: ioBroker.SettableState, ack?: boolean): ioBroker.SetStatePromise;
          /**
           * Creates or overwrites an object (which might not belong to this adapter) in the object db
           *
           * @deprecated use \`adapter.setForeignObject\` without a callback instead
           */
          setForeignObjectAsync<T extends string>(id: T, obj: ioBroker.SettableObject<ioBroker.ObjectIdToObjectType<T, 'write'>>, options?: unknown): ioBroker.SetObjectPromise;
          /** @deprecated a property, not a method */
          oldField?: string;
          /** Fine. */
          setState(id: string, state: ioBroker.SettableState): ioBroker.SetStatePromise;
        }
      }
    }
    export {};
  `;

  const types = (version = "7.2.2", text = TYPES): void => {
    const root = join(dir, "node_modules", "@iobroker", "types");
    mkdirSync(join(root, "build"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@iobroker/types", version }));
    writeFileSync(join(root, "build", "types.d.ts"), text);
  };

  const source = (files: Record<string, string>): void => {
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, "src", name), text);
    }
  };

  const messages = (): string[] =>
    deprecatedAdapterMethodsCheck.run(dir).map((f) => `${f.file}:${f.line ?? 0} ${f.message}`);

  it("is silent when @iobroker/types is not installed", () => {
    source({ "main.ts": `class Main extends utils.Adapter { async f() { await this.setStateAsync("a", 1); } }` });
    expect(deprecatedAdapterMethodsCheck.run(dir)).toEqual([]);
  });

  it("reports the deprecated calls on the adapter with the version and the advice", () => {
    types();
    source({
      "main.ts": `
        class Main extends utils.Adapter {
          async f() {
            await this.setStateAsync("a", 1);
            await this.setState("b", 1);
            await this.setForeignObjectAsync(\`system.adapter.\${this.namespace}\`, obj);
          }
        }`,
      "lib/publisher.ts": `
        export async function publish(adapter: ioBroker.Adapter): Promise<void> {
          await adapter.extendObjectAsync("x", { type: "state" });
          await adapter.extendObject("y", { type: "state" });
        }`,
    });
    expect(messages()).toEqual([
      "src/lib/publisher.ts:3 adapter.extendObjectAsync() is deprecated in @iobroker/types 7.2.2: use `adapter.extendObject` without a callback instead",
      "src/main.ts:4 this.setStateAsync() is deprecated in @iobroker/types 7.2.2: use `adapter.setState` without callback instead",
      "src/main.ts:6 this.setForeignObjectAsync() is deprecated in @iobroker/types 7.2.2: use `adapter.setForeignObject` without a callback instead",
    ]);
  });

  it("takes the advice from the same-line form of the tag without the comment end", () => {
    types();
    source({ "main.ts": `class Main extends utils.Adapter { async f() { await this.setStateAsync("a", 1); } }` });
    const [finding] = deprecatedAdapterMethodsCheck.run(dir);
    expect(finding?.message.endsWith("without callback instead")).toBe(true);
  });

  it("leaves a same-named method of a library class and a deprecated property alone", () => {
    types();
    source({
      "lib/sync.ts": `
        export class Sync {
          private async createState(id: string): Promise<void> { await this.port.extendObject(id, {}); }
          async run(): Promise<void> {
            await this.createState("a");
            await this.setStateAsync("b", 1);
            await this.adapter.oldField("c");
          }
        }`,
    });
    expect(deprecatedAdapterMethodsCheck.run(dir)).toEqual([]);
  });

  it("follows the installed version: an older types file without the tag reports nothing", () => {
    types("7.0.7", TYPES.replace(/@deprecated[^\n]*\n/g, "\n"));
    source({ "main.ts": `class Main extends utils.Adapter { async f() { await this.setStateAsync("a", 1); } }` });
    expect(deprecatedAdapterMethodsCheck.run(dir)).toEqual([]);
  });

  it("does not judge test files", () => {
    types();
    source({ "main.test.ts": `class Main extends utils.Adapter { async f() { await this.setStateAsync("a", 1); } }` });
    expect(deprecatedAdapterMethodsCheck.run(dir)).toEqual([]);
  });
});
