import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handlerGuardCheck } from "./handler-guard.js";

describe("handler-guard", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "handler-guard-"));
    mkdirSync(join(dir, "src"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (body: string): string[] => {
    writeFileSync(join(dir, "src", "main.ts"), body);
    return handlerGuardCheck.run(dir).map((f) => f.message);
  };

  const adapter = (registration: string, method: string): string =>
    `class A {\n  constructor() {\n    ${registration}\n  }\n${method}\n}\n`;

  it("accepts a bound async handler whose whole body is one try", () => {
    const method =
      "  private async onReady(): Promise<void> {\n    try {\n      await x();\n    } catch (e) {\n      log(e);\n    }\n  }";
    expect(
      run(adapter('this.on("ready", this.onReady.bind(this));', method)),
    ).toEqual([]);
  });

  it("reports a handler registered without bind", () => {
    const method =
      "  private async onReady(): Promise<void> {\n    try {\n      await x();\n    } catch {}\n  }";
    expect(run(adapter('this.on("ready", this.onReady);', method))).toEqual([
      expect.stringContaining("without `.bind(this)`"),
    ]);
  });

  it("reports an async handler with a statement outside the try", () => {
    const method =
      "  private async onReady(): Promise<void> {\n    const a = await read();\n    try {\n      await x(a);\n    } catch {}\n  }";
    expect(
      run(adapter('this.on("ready", this.onReady.bind(this));', method)),
    ).toEqual([expect.stringContaining("outside one top-level `try`")]);
  });

  it("accepts a statement that catches its own rejection before the try (ioBroker.shelly)", () => {
    const method =
      "  private async onReady(): Promise<void> {\n    await I18n.init(dir, this).catch((e) => this.log.error(String(e)));\n    try {\n      await x();\n    } catch {}\n  }";
    expect(
      run(adapter('this.on("ready", this.onReady.bind(this));', method)),
    ).toEqual([]);
  });

  it("reports a fire-and-forget call after the try", () => {
    const method =
      "  private async onReady(): Promise<void> {\n    try {\n      await x();\n    } catch {}\n    void this.stop?.();\n  }";
    expect(
      run(adapter('this.on("ready", this.onReady.bind(this));', method)),
    ).toHaveLength(1);
  });

  it("reports an async handler with code after the try", () => {
    const method =
      "  private async onMessage(obj: unknown): Promise<void> {\n    try {\n      await x();\n    } catch {}\n    done();\n  }";
    expect(
      run(adapter('this.on("message", this.onMessage.bind(this));', method)),
    ).toHaveLength(1);
  });

  it("reports an inline async arrow without a top-level try", () => {
    expect(
      run(
        adapter(
          'this.on("stateChange", async (id, state) => { await handle(id, state); });',
          "",
        ),
      ),
    ).toHaveLength(1);
  });

  it("accepts an arrow-function property, which is bound by itself (ioBroker.shelly)", () => {
    const method =
      "  private onReady = async (): Promise<void> => {\n    try {\n      await x();\n    } catch {}\n  };";
    expect(run(adapter('this.on("ready", this.onReady);', method))).toEqual([]);
  });

  it("judges the body of an arrow-function property", () => {
    const method =
      "  private onReady = async (): Promise<void> => {\n    await x();\n  };";
    expect(run(adapter('this.on("ready", this.onReady);', method))).toEqual([
      expect.stringContaining("outside one top-level `try`"),
    ]);
  });

  it("accepts an arrow-function property with an expression body (ioBroker.shelly)", () => {
    const method =
      "  private onObjectChange = (id: string, obj: unknown): void =>\n    this.dm?.onObjectChange(id, obj);";
    expect(
      run(adapter('this.on("objectChange", this.onObjectChange);', method)),
    ).toEqual([]);
  });

  it("accepts an async arrow-function property with an expression body", () => {
    const method =
      "  private onMessage = async (obj: unknown): Promise<void> =>\n    this.router.handle(obj);";
    expect(run(adapter('this.on("message", this.onMessage);', method))).toEqual(
      [],
    );
  });

  it("judges a method whose parameter has a function type", () => {
    const method =
      "  private async onUnload(callback: () => void): Promise<void> {\n    await stop();\n    callback();\n  }";
    expect(
      run(adapter('this.on("unload", this.onUnload.bind(this));', method)),
    ).toEqual([expect.stringContaining("outside one top-level `try`")]);
  });

  it("accepts a synchronous handler as it is", () => {
    const method =
      "  private onUnload(callback: () => void): void {\n    stop();\n    callback();\n  }";
    expect(
      run(adapter('this.on("unload", this.onUnload.bind(this));', method)),
    ).toEqual([]);
  });
});
