import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instanceObjectsRefreshCheck } from "./instance-objects-refresh.js";

describe("instance-objects-refresh", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "instance-objects-refresh-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Manifest with the given ids plus one main.ts; `withSrc: false` leaves src/ out.
   *
   * @param ids the `instanceObjects` ids of the manifest
   * @param source the text of src/main.ts
   * @param options what else the adapter carries
   * @param options.withSrc false leaves src/ out
   * @param options.testSource the text of src/main.test.ts
   * @param options.extra the text of src/lib/helper.ts
   */
  const adapter = (
    ids: string[],
    source: string,
    options: { withSrc?: boolean; testSource?: string; extra?: string } = {},
  ): void => {
    writeFileSync(
      join(dir, "io-package.json"),
      JSON.stringify({
        common: { name: "demo" },
        instanceObjects: ids.map((_id) => ({ _id })),
      }),
    );
    if (options.withSrc ?? true) {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "main.ts"), source);
      if (options.testSource !== undefined) {
        writeFileSync(join(dir, "src", "main.test.ts"), options.testSource);
      }
      if (options.extra !== undefined) {
        mkdirSync(join(dir, "src", "lib"));
        writeFileSync(join(dir, "src", "lib", "helper.ts"), options.extra);
      }
    }
  };

  const run = (): ReturnType<typeof instanceObjectsRefreshCheck.run> =>
    instanceObjectsRefreshCheck.run(dir);

  it("reports an object that is never extended", () => {
    adapter(
      ["info", "info.connection"],
      "await this.setState('info.connection', {val: false});",
    );
    const findings = run();
    expect(findings).toHaveLength(2);
    expect(findings[0]?.message).toContain("'info'");
    expect(findings[0]?.message).toContain("extendObject");
    expect(findings[0]?.file).toBe("io-package.json");
  });

  it("accepts an extended object", () => {
    adapter(
      ["info", "info.connection"],
      "await this.extendObject('info', {common: {name: n}});\n" +
        'await this.extendObject("info.connection", {common: {name: n}});\n',
    );
    expect(run()).toEqual([]);
  });

  it("does not count a call that is commented out", () => {
    // tooling audit 2026-09-24 (P2): the comment counted as the refresh
    adapter(
      ["info.connection"],
      `class A { onReady() {\n  // await this.extendObject("info.connection", { common: { name: n } });\n  /* this.extendObject("info.connection", {}) */\n} }`,
    );
    const findings = instanceObjectsRefreshCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("never refreshed");
  });

  it("counts the async variant and backticks", () => {
    adapter(
      ["info", "info.connection"],
      "await this.extendObjectAsync(`info`, {});\nawait this.extendObject(  'info.connection' , {});\n",
    );
    expect(run()).toEqual([]);
  });

  it("reports only the missing object", () => {
    adapter(
      ["info", "info.connection"],
      "await this.extendObject('info', {});",
    );
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("'info.connection'");
  });

  it("does not count a call in a test file", () => {
    // A test does not describe the shipped state: the call has to sit in production code.
    adapter(["info"], "await this.setState('info.connection', {val: false});", {
      testSource: "await this.extendObject('info', {});",
    });
    expect(run()).toHaveLength(1);
  });

  it("is not satisfied by a similar id", () => {
    adapter(
      ["info.connection"],
      "await this.extendObject('info.connectionState', {});",
    );
    expect(run()).toHaveLength(1);
  });

  it("reports a call in a method nobody invokes, with its line", () => {
    // Measured on a real adapter: drop just the call line from onReady and method plus
    // call remain — no installation is reached, and neither lint nor tsc notice.
    adapter(
      ["info"],
      "  private async refreshOwnObjects(): Promise<void> {\n" +
        "    await this.extendObject('info', {common: {name: n}});\n" +
        "  }\n",
    );
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("nothing calls that method");
    expect(findings[0]?.message).toContain("refreshOwnObjects");
    expect(findings[0]?.file).toBe("src/main.ts");
    expect(findings[0]?.line).toBe(2);
  });

  it("accepts the same method when onReady calls it", () => {
    adapter(
      ["info"],
      "  private async onReady(): Promise<void> {\n" +
        "    await this.refreshOwnObjects();\n" +
        "  }\n" +
        "  private async refreshOwnObjects(): Promise<void> {\n" +
        "    await this.extendObject('info', {common: {name: n}});\n" +
        "  }\n",
    );
    expect(run()).toEqual([]);
  });

  it("needs no second caller for a call straight in onReady", () => {
    adapter(
      ["info"],
      "  private async onReady(): Promise<void> {\n" +
        "    await this.extendObject('info', {common: {name: n}});\n" +
        "  }\n",
    );
    expect(run()).toEqual([]);
  });

  it("accepts a helper-class method when something calls it", () => {
    // Not every adapter creates its objects in main.ts — a call through a member
    // (this.stateManager.syncObjects()) must not count as dead.
    adapter(
      ["info"],
      "  public async syncObjects(): Promise<void> {\n" +
        "    await this.adapter.extendObject('info', {common: {name: n}});\n" +
        "  }\n" +
        "  private async boot(): Promise<void> {\n" +
        "    await this.stateManager.syncObjects();\n" +
        "  }\n",
    );
    expect(run()).toEqual([]);
  });

  it("finds the caller in another source file", () => {
    adapter(
      ["info"],
      "  private async onReady(): Promise<void> {\n" +
        "    await this.objects.syncObjects();\n" +
        "  }\n",
      {
        extra:
          "  public async syncObjects(): Promise<void> {\n" +
          "    await this.adapter.extendObject('info', {common: {name: n}});\n" +
          "  }\n",
      },
    );
    expect(run()).toEqual([]);
  });

  it("bounds a method name the way python's \\b did next to a non-ASCII letter", () => {
    // `refreshOwnObjectsÄ` is a different identifier: it must not count as a reference.
    adapter(
      ["info"],
      "  private async refreshOwnObjects(): Promise<void> {\n" +
        "    await this.extendObject('info', {common: {name: n}});\n" +
        "  }\n" +
        "  private async other(): Promise<void> {\n" +
        "    await this.refreshOwnObjectsÄ();\n" +
        "  }\n",
    );
    expect(run()).toHaveLength(1);
  });

  describe("the refresh carries name and description only (0.19.0)", () => {
    const refresh = (literal: string): string =>
      `class A { async onReady(): Promise<void> { await this.extendObjectAsync("info.x", ${literal}); } }`;

    it("accepts name and description, shorthand and translated texts", () => {
      adapter(
        ["info.x"],
        refresh('{ common: { name: tName("a {b}"), desc } }'),
      );
      expect(run()).toEqual([]);
    });

    it("names every shape key copied into common", () => {
      adapter(
        ["info.x"],
        refresh(
          '{ common: { name: "x", type: "boolean", role: "indicator", read: true, write: false, def: false } }',
        ),
      );
      const findings = run();
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain(
        "(common.type, common.role, common.read, common.write, common.def)",
      );
      expect(findings[0]?.file).toBe("src/main.ts");
      expect(findings[0]?.line).toBe(1);
    });

    it("reports the object type and native next to common", () => {
      adapter(
        ["info.x"],
        refresh('{ type: "state", common: { name: "x" }, native: {} }'),
      );
      expect(run()[0]?.message).toContain("(type, native)");
    });

    it("leaves states from the device, spreads and non-literal arguments alone", () => {
      adapter(["info.x"], refresh("{ common: { states: this.inputs } }"));
      expect(run()).toEqual([]);
      adapter(["info.x"], refresh("{ ...base, common: { name: 'x' } }"));
      expect(run()).toEqual([]);
      adapter(["info.x"], refresh("obj"));
      expect(run()).toEqual([]);
      adapter(["info.x"], refresh("{ common: shape }"));
      expect(run()).toEqual([]);
    });

    it("reports a second runtime copy beside a clean refresh (0.31.0)", () => {
      adapter(
        ["info.x"],
        `${refresh(
          '{ common: { name: "x" } }',
        )}\nclass B { async repair(): Promise<void> { await this.extendObjectAsync("info.x", { common: { role: "indicator" } }); } }`,
      );
      expect(run().map((f) => f.message)).toEqual([
        expect.stringContaining(
          "more than its name and description (common.role)",
        ),
      ]);
    });

    it("reports a shape written by setObjectNotExists or setObject (0.31.0)", () => {
      adapter(
        ["info.x"],
        `${refresh(
          '{ common: { name: "x" } }',
        )}\nclass B { async make(): Promise<void> { await this.setObjectNotExistsAsync("info.x", { type: "state", common: { name: "x", type: "boolean" }, native: {} }); } }`,
      );
      expect(run()[0]?.message).toContain("(type, common.type, native)");
    });

    it("does not read a key inside a nested object or a string as a shape key", () => {
      adapter(
        ["info.x"],
        refresh(
          '{ common: { name: { en: "role: x", de: "type" }, desc: `unit: ${u}` } }',
        ),
      );
      expect(run()).toEqual([]);
    });
  });

  describe("a refresh from a table (0.35.0)", () => {
    // tooling round 146 (fakeroku audit 2026-10-22): only the literal call counted, so an adapter wrote one block per
    // manifest object instead of one loop, and the fleet master KnownObjects.extend did not count at all
    it("accepts a loop over a table that names the id, with extendObject or KnownObjects.extend", () => {
      adapter(
        ["info.a", "info.b", "info.c"],
        "const OWN = [['info.a', 'A'], ['info.b', 'B']] as const;\n" +
          "const MORE = { 'info.c': 'C' };\n" +
          "class X {\n  async onReady(): Promise<void> {\n" +
          "    for (const [id, name] of OWN) {\n      await this.extendObject(id, { common: { name } });\n    }\n" +
          "    for (const [key, name] of Object.entries(MORE)) {\n      await this.known.extend(key, { common: { name } });\n    }\n" +
          "  }\n}\n",
      );
      expect(run()).toEqual([]);
    });

    it("accepts KnownObjects.extend with the literal id", () => {
      adapter(
        ["info.a"],
        "await this.known.extend('info.a', { common: { name: n } });\n",
      );
      expect(run()).toEqual([]);
    });

    it("still reports an id the table does not name, and a loop that writes something else", () => {
      adapter(
        ["info.a", "info.b"],
        "const OWN = ['info.a'];\nconst OTHER = ['info.b'];\n" +
          "for (const id of OWN) {\n  await this.extendObject(id, { common: { name: id } });\n}\n" +
          "for (const id of OTHER) {\n  await this.setState(id, false, true);\n}\n",
      );
      expect(run().map((f) => f.message)).toEqual([
        "'info.b' is never refreshed with extendObject",
      ]);
    });

    it("judges the shape a KnownObjects.extend writes like an extendObject", () => {
      adapter(
        ["info.a"],
        "await this.known.extend('info.a', { common: { name: n, role: 'state' } });\n",
      );
      expect(run().map((f) => f.message)).toEqual([
        "'info.a' is refreshed with more than its name and description (common.role)",
      ]);
    });

    it("reports a table loop in a method nobody invokes", () => {
      adapter(
        ["info.a"],
        "const OWN = ['info.a'];\nclass X {\n  private refresh(): void {\n" +
          "    for (const id of OWN) {\n      void this.extendObject(id, { common: { name: id } });\n    }\n  }\n}\n",
      );
      const findings = run();
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("refresh()");
      expect(findings[0]?.line).toBe(5);
    });

    it("does not read a table loop without a block, or a table that is never declared", () => {
      adapter(
        ["info.a"],
        "for (const id of OWN) void this.extendObject(id, {});\nconst x = ['info.a'];\n",
      );
      expect(run()).toHaveLength(1);
    });
  });

  it("accepts an adapter without instance objects", () => {
    adapter([], "");
    expect(run()).toEqual([]);
  });

  it("skips an adapter without src/", () => {
    // A plain JavaScript adapter without src/ is not judged rather than reported wrongly.
    adapter(["info"], "", { withSrc: false });
    expect(run()).toEqual([]);
  });

  it("says nothing without a manifest", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "main.ts"), "");
    expect(run()).toEqual([]);
  });
});
