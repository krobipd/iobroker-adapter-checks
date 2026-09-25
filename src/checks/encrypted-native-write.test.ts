import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptedNativeWriteCheck } from "./encrypted-native-write.js";

describe("encrypted-native-write", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "encrypted-native-write-"));
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const adapter = (encrypted: string[] | undefined, main: string): void => {
    writeFileSync(
      join(dir, "io-package.json"),
      JSON.stringify({ common: { name: "demo" }, native: {}, ...(encrypted ? { encryptedNative: encrypted } : {}) }),
    );
    writeFileSync(join(dir, "src", "main.ts"), main);
  };

  const messages = (): string[] =>
    encryptedNativeWriteCheck.run(dir).map((f) => `${f.file}:${f.line ?? 0} ${f.message}`);

  /** hueemu before the fix (audit 2026-09-25): the generated TLS key merged into the instance object in clear text. */
  const CLEAR = `
    class HueEmu extends utils.Adapter {
      private async persist(material: { key: string; cert: string }): Promise<void> {
        await this.extendForeignObjectAsync(\`system.adapter.\${this.namespace}\`, {
          native: { tlsKey: material.key, tlsCert: material.cert },
        });
      }
    }`;

  it("reports a clear-text write of an encryptedNative key, and only that key", () => {
    adapter(["tlsKey"], CLEAR);
    expect(messages()).toEqual([
      "src/main.ts:4 extendForeignObjectAsync writes native.tlsKey (listed in encryptedNative) without encrypt()",
    ]);
  });

  it("accepts the value written through encrypt(), awaited or not, and a null that drops it", () => {
    adapter(
      ["tlsKey", "token"],
      `
      class A extends utils.Adapter {
        private async persist(key: string): Promise<void> {
          await this.extendForeignObjectAsync(\`system.adapter.\${this.namespace}\`, {
            native: { tlsKey: this.encrypt(key), token: null },
          });
          await this.adapter.setForeignObjectAsync("system.adapter.demo.0", { native: { tlsKey: (encrypt(key)) } } as never);
        }
      }`,
    );
    expect(messages()).toEqual([]);
  });

  it("follows a local object written as native — hueemu's actual form", () => {
    adapter(
      ["tlsKey"],
      `
      class HueEmu extends utils.Adapter {
        private async onReady(): Promise<void> {
          const generated: Record<string, string> = { mac: "x" };
          const material = { key: "k", cert: "c", generated: true };
          if (material.generated) {
            generated.tlsCert = material.cert;
            generated.tlsKey = material.key;
          }
          await this.extendForeignObjectAsync(\`system.adapter.\${this.namespace}\`, { native: generated });
          const safe: Record<string, string> = {};
          safe["tlsKey"] = this.encrypt(material.key);
          await this.extendForeignObjectAsync(\`system.adapter.\${this.namespace}\`, { native: safe });
        }
      }`,
    );
    expect(messages()).toEqual([
      "src/main.ts:10 extendForeignObjectAsync writes native.tlsKey (listed in encryptedNative) without encrypt()",
    ]);
  });

  it("accepts a write that clears the setting — govee's verification code reset", () => {
    adapter(
      ["mqttVerificationCode"],
      `
      export async function clear(adapter: ioBroker.Adapter): Promise<void> {
        await adapter.extendForeignObjectAsync(\`system.adapter.\${adapter.namespace}\`, { native: { mqttVerificationCode: "" } });
        await adapter.extendForeignObjectAsync(\`system.adapter.\${adapter.namespace}\`, { native: { mqttVerificationCode: undefined } });
      }`,
    );
    expect(messages()).toEqual([]);
  });

  it("reports a shorthand and a quoted key — the value is a variable nobody encrypted here", () => {
    adapter(
      ["tlsKey", "password"],
      `
      class A extends utils.Adapter {
        private async persist(tlsKey: string, pw: string): Promise<void> {
          await this.extendForeignObjectAsync(\`system.adapter.\${this.namespace}\`, { native: { tlsKey, "password": pw } });
        }
      }`,
    );
    expect(messages()).toEqual([
      "src/main.ts:4 extendForeignObjectAsync writes native.tlsKey (listed in encryptedNative) without encrypt()",
      "src/main.ts:4 extendForeignObjectAsync writes native.password (listed in encryptedNative) without encrypt()",
    ]);
  });

  it("does not judge other ids, a native passed as a variable, updateConfig, or an adapter without encryptedNative", () => {
    adapter(
      ["tlsKey"],
      `
      class A extends utils.Adapter {
        private async persist(patch: Record<string, unknown>, key: string): Promise<void> {
          await this.extendForeignObjectAsync("hueemu.0.info", { native: { tlsKey: key } });
          await this.extendForeignObjectAsync(\`system.adapter.\${this.namespace}\`, { native: patch });
          await this.updateConfig({ tlsKey: key });
        }
      }`,
    );
    expect(messages()).toEqual([]);
    adapter(undefined, CLEAR);
    expect(messages()).toEqual([]);
  });
});
