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

  /** Manifest with the given ids plus one main.ts; `withSrc: false` leaves src/ out. */
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
      mkdirSync(join(dir, "src"));
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
      "await this.extendObject('info', {type: 'channel'});\n" +
        'await this.extendObject("info.connection", {type: "state"});\n',
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
    expect(findings[0].message).toContain("never refreshed");
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
        "    await this.extendObject('info', {type: 'channel'});\n" +
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
        "    await this.extendObject('info', {type: 'channel'});\n" +
        "  }\n",
    );
    expect(run()).toEqual([]);
  });

  it("needs no second caller for a call straight in onReady", () => {
    adapter(
      ["info"],
      "  private async onReady(): Promise<void> {\n" +
        "    await this.extendObject('info', {type: 'channel'});\n" +
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
        "    await this.adapter.extendObject('info', {type: 'channel'});\n" +
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
          "    await this.adapter.extendObject('info', {type: 'channel'});\n" +
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
        "    await this.extendObject('info', {type: 'channel'});\n" +
        "  }\n" +
        "  private async other(): Promise<void> {\n" +
        "    await this.refreshOwnObjectsÄ();\n" +
        "  }\n",
    );
    expect(run()).toHaveLength(1);
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
