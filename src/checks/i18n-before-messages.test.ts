import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18nBeforeMessagesCheck } from "./i18n-before-messages.js";

describe("i18n-before-messages", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i18n-before-messages-"));
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

  const found = (): string[] =>
    i18nBeforeMessagesCheck
      .run(dir)
      .map((f) => `${f.file}:${f.line ?? 0} ${f.message}`);

  const manager = [
    'import { DeviceManagement } from "@iobroker/dm-utils";',
    // the subclass first: recognizing it needs a second pass over the classes
    "export class SubDm extends Dm {}",
    "export class Dm extends DeviceManagement<any> {}",
  ].join("\n");

  it("is silent without I18n — a device manager that translates nothing has nothing to wait for", () => {
    adapter({
      "main.ts": [
        "class A extends utils.Adapter {",
        "  dm = new Dm(this);",
        '  constructor(o: any) { super(o); this.on("message", this.onMessage.bind(this)); }',
        "}",
      ].join("\n"),
    });
    expect(found()).toEqual([]);
  });

  it("accepts shelly's order", () => {
    adapter({
      "lib/dm.ts": manager,
      "main.ts": [
        "class A extends utils.Adapter {",
        "  constructor(o: any) {",
        "    super({ ...o, name: 'demo' });",
        "    this.on('ready', this.onReady);",
        "  }",
        "  private onReady = async (): Promise<void> => {",
        "    await I18n.init(__dirname, this).catch(error => this.log.error(`${error}`));",
        "    this.dm = new SubDm(this);",
        "    this.on('message', (obj) => this.onMessage(obj));",
        "  };",
        "}",
      ].join("\n"),
    });
    expect(found()).toEqual([]);
  });

  it("accepts I18n.init as the first statement of a leading try, also through utils.I18n", () => {
    adapter({
      "lib/dm.ts": manager,
      "main.ts": [
        "class A extends utils.Adapter {",
        "  async onReady(): Promise<void> {",
        "    try {",
        "      await utils.I18n.init(join(this.adapterDir, 'admin'), this);",
        "      this.dm = new Dm(this);",
        "    } catch (e) { this.log.error(errText(e)); }",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(found()).toEqual([]);
  });

  it("reports I18n.init that is not the first statement", () => {
    adapter({
      "main.ts": [
        "class A extends utils.Adapter {",
        "  async onReady(): Promise<void> {",
        "    await this.setState('info.connection', false, true);",
        "    await I18n.init(join(this.adapterDir, 'admin'), this);",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(found()).toEqual([
      "src/main.ts:4 I18n.init is not the first statement of onReady",
    ]);
  });

  it("reports a device manager built before I18n.init — field, constructor, earlier in onReady, another function", () => {
    adapter({
      "lib/dm.ts": manager,
      "main.ts": [
        "class A extends utils.Adapter {",
        "  private dm = new Dm(this);",
        "  constructor(o: any) {",
        "    super(o);",
        "    this.other = new SubDm(this);",
        "  }",
        "  async onReady(): Promise<void> {",
        "    await I18n.init(join(this.adapterDir, 'admin'), this);",
        "  }",
        "  private start(): void {",
        "    this.third = new DeviceManagement(this);",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(found()).toEqual([
      "src/main.ts:2 the device manager Dm is constructed before I18n.init has run",
      "src/main.ts:5 the device manager SubDm is constructed before I18n.init has run",
      "src/main.ts:11 the device manager DeviceManagement is constructed before I18n.init has run",
    ]);
  });

  it("reports a device manager built in onReady before I18n.init", () => {
    adapter({
      "lib/dm.ts": manager,
      "main.ts": [
        "class A extends utils.Adapter {",
        "  async onReady(): Promise<void> {",
        "    this.dm = new Dm(this);",
        "    await I18n.init(join(this.adapterDir, 'admin'), this);",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(found()).toEqual([
      "src/main.ts:4 I18n.init is not the first statement of onReady",
      "src/main.ts:3 the device manager Dm is constructed before I18n.init has run",
    ]);
  });

  it("reports a message handler registered in the constructor, by on() or as a super() option", () => {
    adapter({
      "main.ts": [
        "class A extends utils.Adapter {",
        "  constructor(o: any) {",
        "    super({ ...o, name: 'demo', message: (obj: any) => this.onMessage(obj) });",
        '    this.on("message", this.onMessage.bind(this));',
        "    this.on('ready', () => { this.on('message', () => undefined); });",
        "  }",
        "  async onReady(): Promise<void> {",
        "    await I18n.init(join(this.adapterDir, 'admin'), this);",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(found()).toEqual([
      "src/main.ts:3 the constructor passes a message handler to super() before I18n.init has run",
      "src/main.ts:4 the constructor registers a message handler before I18n.init has run",
    ]);
  });
});
