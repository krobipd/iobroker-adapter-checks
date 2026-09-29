import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrationResultUsedCheck } from "./migration-result-used.js";

describe("migration-result-used", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migration-result-used-"));
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

  const lines = (): string[] => migrationResultUsedCheck.run(dir).map((f) => `${f.file}:${f.line ?? 0}`);

  it("is silent without src/ and without the helper", () => {
    expect(migrationResultUsedCheck.run(dir)).toEqual([]);
    adapter({ "main.ts": "class A extends utils.Adapter { async onReady() { await this.start(); } }\n" });
    expect(migrationResultUsedCheck.run(dir)).toEqual([]);
  });

  it("reports a dropped result — awaited, bare or under void (yamaha 3.0.1, A36)", () => {
    adapter({
      "main.ts": [
        "class A extends utils.Adapter {",
        "  async onReady() {",
        "    await migrateNativeKeys(this, migrations, errText);",
        "    migrateNativeKeys(this, migrations, errText);",
        "    void migrateNativeKeys(this, migrations, errText);",
        "    await (migrateNativeKeys(this, migrations, errText) as Promise<boolean>);",
        "    this.startServer();",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(lines()).toEqual(["src/main.ts:3", "src/main.ts:4", "src/main.ts:5", "src/main.ts:6"]);
  });

  it("accepts every use of the result", () => {
    adapter({
      "main.ts": [
        "class A extends utils.Adapter {",
        "  async onReady() {",
        "    if (await migrateNativeKeys(this, migrations, errText)) {",
        "      return;",
        "    }",
        "    const moved = await migrateNativeKeys(this, more, errText);",
        "    if (moved || !(await migrateNativeKeys(this, rest, errText))) return;",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(lines()).toEqual([]);
  });

  it("follows a wrapper that returns the result, by name, into its callers (fakeroku, hassemu)", () => {
    adapter({
      "lib/legacy-migration.ts": [
        "export async function migrateLegacy(adapter: A): Promise<boolean> {",
        "  return await migrateNativeKeys(adapter, DROPS, errText);",
        "}",
        "export const viaArrow = (adapter: A) => migrateNativeKeys(adapter, DROPS, errText);",
      ].join("\n"),
      "main.ts": [
        "class A extends utils.Adapter {",
        "  private migrateBind(native: object): Promise<boolean> {",
        "    return migrateNativeKeys(this, bindKeyMigrations(native), errText);",
        "  }",
        "  async onReady() {",
        "    if (await migrateLegacy(this)) return;",
        "    if (await this.migrateBind(this.config)) return;",
        "    await this.migrateBind(this.config);",
        "    await viaArrow(this);",
        "  }",
        "}",
      ].join("\n"),
    });
    const findings = migrationResultUsedCheck.run(dir);
    expect(findings.map((f) => `${f.file}:${f.line ?? 0}`)).toEqual(["src/main.ts:8", "src/main.ts:9"]);
    expect(findings[0]?.message).toContain("migrateBind (which returns the result of migrateNativeKeys)");
  });
});
