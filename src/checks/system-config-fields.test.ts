import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemConfigFieldsCheck } from "./system-config-fields.js";

describe("system-config-fields", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "system-config-fields-"));
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const source = (rel: string, text: string): void => {
    writeFileSync(join(dir, "src", rel), text);
  };

  it("reports this.language read in an adapter class without useFormatDate", () => {
    source(
      "main.ts",
      `class Demo extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: "demo" });
  }
  label(): string {
    return this.language ?? "en";
  }
}`,
    );
    const findings = systemConfigFieldsCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "src/main.ts", line: 6 });
    expect(findings[0].message).toContain("this.language");
  });

  it("reports two reads of the same field on one line once", () => {
    source(
      "main.ts",
      `class Demo extends utils.Adapter {
  loc() { return this.language ? TABLE[this.language] : undefined; }
}`,
    );
    expect(systemConfigFieldsCheck.run(dir)).toHaveLength(1);
  });

  it("reports every one of the five fields", () => {
    source(
      "main.ts",
      `class Demo extends Adapter {
  a() { return [this.dateFormat, this.isFloatComma, this.language, this.longitude, this.latitude]; }
}`,
    );
    expect(
      systemConfigFieldsCheck.run(dir).map((f) => f.message.split(" ")[0]),
    ).toEqual([
      "this.dateFormat",
      "this.isFloatComma",
      "this.language",
      "this.longitude",
      "this.latitude",
    ]);
  });

  it("reports a read through this.adapter in a library class", () => {
    source(
      "lib/labels.ts",
      `export class Labels {
  constructor(private readonly adapter: ioBroker.Adapter) {}
  lang(): string { return this.adapter.language || "en"; }
}`,
    );
    source("main.ts", `class Demo extends utils.Adapter {}`);
    const findings = systemConfigFieldsCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "src/lib/labels.ts", line: 3 });
  });

  it("reports systemConfig: true — that option does not fill the fields", () => {
    source(
      "main.ts",
      `class Demo extends utils.Adapter {
  constructor(options = {}) {
    options = { ...options, name: "demo", systemConfig: true };
    super(options);
  }
  n(name: Record<string, string>) { return name[this.language || "en"]; }
}`,
    );
    expect(systemConfigFieldsCheck.run(dir)).toHaveLength(1);
  });

  it("says nothing when the constructor passes useFormatDate: true", () => {
    source(
      "main.ts",
      `class Demo extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: "demo", useFormatDate: true });
  }
  label(): string { return this.language ?? "en"; }
}`,
    );
    source(
      "lib/labels.ts",
      `export const lang = (adapter: ioBroker.Adapter) => adapter.language;`,
    );
    expect(systemConfigFieldsCheck.run(dir)).toEqual([]);
  });

  it("still reports when useFormatDate: true sits in an unrelated object", () => {
    source(
      "main.ts",
      `class Demo extends utils.Adapter {
  label(): string { return this.language ?? "en"; }
}
function unrelated() { return { useFormatDate: true }; }`,
    );
    source(
      "lib/other.ts",
      `export const settings = { useFormatDate: true };`,
    );
    expect(systemConfigFieldsCheck.run(dir)).toHaveLength(1);
  });

  it("accepts the legacy factory utils.adapter({ useFormatDate: true })", () => {
    source(
      "main.ts",
      `const adapter = utils.adapter({ name: "demo", useFormatDate: true });
export const lang = () => adapter.language;`,
    );
    expect(systemConfigFieldsCheck.run(dir)).toEqual([]);
  });

  it("accepts the option merged with Object.assign into new utils.Adapter", () => {
    source(
      "main.ts",
      `export function start(options = {}) {
  return new utils.Adapter(Object.assign({}, options, { name: "demo", useFormatDate: true }));
}
export const lang = (adapter: ioBroker.Adapter) => adapter.language;`,
    );
    expect(systemConfigFieldsCheck.run(dir)).toEqual([]);
  });

  it("still reports useFormatDate: false", () => {
    source(
      "main.ts",
      `class Demo extends utils.Adapter {
  constructor(options = {}) { super({ ...options, useFormatDate: false }); }
  label(): string { return this.language ?? "en"; }
}`,
    );
    expect(systemConfigFieldsCheck.run(dir)).toHaveLength(1);
  });

  it("leaves a field alone that the adapter class declares and fills itself", () => {
    source(
      "main.ts",
      `class Demo extends utils.Adapter {
  public language: ioBroker.Languages = "en";
  async onReady() {
    const cfg = await this.getForeignObjectAsync("system.config");
    this.language = cfg?.common?.language || "en";
  }
  label(): string { return this.language; }
}`,
    );
    expect(systemConfigFieldsCheck.run(dir)).toEqual([]);
  });

  it("leaves a field alone that the adapter assigns without declaring it", () => {
    source(
      "main.ts",
      `class Demo extends utils.Adapter {
  async onReady() {
    this.language ??= "en";
  }
  label(): string { return this.language; }
}`,
    );
    expect(systemConfigFieldsCheck.run(dir)).toEqual([]);
  });

  it("does not count an own field of a class that is not the adapter", () => {
    source(
      "lib/device-manager.ts",
      `export class Manager {
  private language: ioBroker.Languages = "en";
  sort(a: string) { return getText(a, this.language); }
}`,
    );
    source("main.ts", `class Demo extends utils.Adapter {}`);
    expect(systemConfigFieldsCheck.run(dir)).toEqual([]);
  });

  it("does not count another adapter field that happens to be declared", () => {
    source(
      "main.ts",
      `class Demo extends utils.Adapter {
  public dateFormat = "DD.MM.YYYY";
  label(): string { return this.language ?? "en"; }
}`,
    );
    const findings = systemConfigFieldsCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("this.language");
  });

  it("does not count a method call of the same name", () => {
    source(
      "main.ts",
      `class Demo extends utils.Adapter {
  label(): string { return this.language(); }
}`,
    );
    expect(systemConfigFieldsCheck.run(dir)).toEqual([]);
  });

  it("says nothing without src/", () => {
    rmSync(join(dir, "src"), { recursive: true, force: true });
    expect(systemConfigFieldsCheck.run(dir)).toEqual([]);
  });
});
