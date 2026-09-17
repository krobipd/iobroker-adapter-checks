import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireAndForgetRejectionCheck } from "./fire-and-forget-rejection.js";

describe("fire-and-forget-rejection", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fire-and-forget-rejection-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Files by repository path (`src/…`). */
  const adapter = (files: Record<string, string>): void => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
  };

  const lines = (): string[] =>
    fireAndForgetRejectionCheck.run(dir).map((f) => `${f.file}:${f.line ?? 0} ${f.message}`);

  it("is silent without src/", () => {
    expect(fireAndForgetRejectionCheck.run(dir)).toEqual([]);
  });

  it("accepts a callee whose body is one try/catch behind guards, a chain with .catch() or a two-argument .then(), and an unresolvable callee", () => {
    adapter({
      "src/main.ts": `
        class Main extends utils.Adapter {
          private polling = false;
          onReady(): void {
            void this.poll();
            void this.poll().finally(() => undefined);
            void this.setState("info.connection", true, true);
            void this.setState("x", 1).then(() => this.log.debug("written"));
            void Promise.all([this.setState("a", 1)]).finally(() => undefined);
            void this.load().catch((e: unknown) => this.log.warn(String(e)));
            void this.load().then(() => undefined, () => undefined);
            void (async () => {
              try {
                await this.load();
              } catch {
                // handled
              }
            })();
            void 0;
          }
          private async poll(): Promise<void> {
            if (this.polling) {
              this.log.debug("skipped");
              return;
            }
            const started = Date.now();
            try {
              await this.load();
            } catch (e) {
              this.log.warn(String(e));
            } finally {
              this.polling = false;
            }
            this.log.debug(\`took \${Date.now() - started}\`);
            this.load().then(() => undefined, () => undefined);
          }
          private async load(): Promise<void> {
            await this.setStateAsync("y", 1);
          }
        }
      `,
    });
    expect(lines()).toEqual([]);
  });

  it("reports an await after the catch (yamaha 2.10.0 applyCommand), naming every call site, and a .then() on it whose root rejects", () => {
    adapter({
      "src/lib/device-controller.ts": `
        export class DeviceController {
          constructor(private readonly client: { send: (c: string) => Promise<void>; status: (z: string) => Promise<string> }) {}
          onStateChange(zone: string): void {
            void this.applyCommand("PWR", zone);
          }
          rename(zone: string, value: string): boolean {
            void this.applyCommand(value, zone).then((ok) => {
              if (ok) {
                this.remember(value);
              }
            });
            void this.applyCommand("SCENE", zone);
            return true;
          }
          private remember(_value: string): void {}
          private async applyCommand(command: string, zone: string): Promise<boolean> {
            try {
              await this.client.send(command);
            } catch (e) {
              return false;
            }
            await this.refreshZone(zone);
            return true;
          }
          private async refreshZone(zone: string): Promise<void> {
            const status = await this.client.status(zone);
            this.remember(status);
          }
        }
      `,
    });
    expect(lines()).toEqual([
      "src/lib/device-controller.ts:8 `void … .then(…)` without `.catch(…)`: a rejection of `this.applyCommand(…)` has no receiver",
      "src/lib/device-controller.ts:23 `applyCommand` is dropped with `void` at src/lib/device-controller.ts:5, src/lib/device-controller.ts:13, and `await this.refreshZone(zone)` can reject outside its try/catch",
    ]);
    expect(fireAndForgetRejectionCheck.run(dir)[0]?.impact).toContain("unhandled rejection");
  });

  it("follows an awaited own callee: an await of a guarded function is no risk, an await of an unguarded one is", () => {
    adapter({
      "src/main.ts": `
        class Main extends utils.Adapter {
          onReady(): void {
            void this.retry();
            void this.report();
          }
          private async retry(): Promise<void> {
            for (const device of this.pending) {
              await this.start(device);
            }
          }
          private async start(device: string): Promise<boolean> {
            try {
              await this.setStateAsync(device, 1);
              return true;
            } catch {
              return false;
            }
          }
          private async report(): Promise<void> {
            const all = this.running === this.expected;
            await this.setState("info.connection", { val: all, ack: true });
          }
        }
      `,
    });
    expect(lines()).toEqual([
      "src/main.ts:22 `report` is dropped with `void` at src/main.ts:5, and its body has no try/catch — `await this.setState(\"info.connection\", { val: all, ack: t…` can reject",
    ]);
  });

  it("reports a try without catch clause, a catch clause that rethrows, an expression body, and a returned promise", () => {
    adapter({
      "src/main.ts": `
        class Main extends utils.Adapter {
          onReady(): void {
            void this.pollAccount();
            void this.rethrows();
            void this.arrow();
            void this.delegates();
          }
          private async pollAccount(): Promise<void> {
            this.polling = true;
            try {
              await this.pollOnce();
            } finally {
              this.polling = false;
            }
          }
          private async pollOnce(): Promise<void> {
            await this.setStateAsync("x", 1);
          }
          private async rethrows(): Promise<void> {
            try {
              await this.pollOnce();
            } catch (e) {
              this.log.error(String(e));
              throw e;
            }
          }
          private arrow = async (): Promise<void> => this.pollOnce();
          private delegates(): Promise<void> {
            return this.pollOnce();
          }
        }
      `,
    });
    expect(lines()).toEqual([
      "src/main.ts:12 `pollAccount` is dropped with `void` at src/main.ts:4, and its try has no catch clause — `await this.pollOnce()` can reject through it",
      "src/main.ts:25 `rethrows` is dropped with `void` at src/main.ts:5, and its catch clause rethrows: `throw e;`",
      "src/main.ts:28 `arrow` is dropped with `void` at src/main.ts:6, and its expression body has no try/catch — `this.pollOnce()` returns a promise that can reject",
      "src/main.ts:30 `delegates` is dropped with `void` at src/main.ts:7, and its body has no try/catch — `return this.pollOnce();` returns a promise that can reject",
    ]);
  });

  it("judges .then() callbacks and finally-only chains by what can reject, and knows allSettled and Promise.resolve never do (hassemu 1.44.0 shutdown)", () => {
    adapter({
      "src/main.ts": `
        class Main extends utils.Adapter {
          onUnload(callback: () => void): void {
            const pending = [this.setStateAsync("a", 1), this.setStateAsync("b", 2)];
            void Promise.allSettled(pending)
              .then((results) => {
                for (const r of results) {
                  if (r.status === "rejected") {
                    this.log.error(\`Shutdown error: \${String(r.reason)}\`);
                  }
                }
              })
              .finally(callback);
            void this.flush().then(() => this.log.debug("done"));
            void this.flush().then(async () => {
              await this.setStateAsync("c", 3);
            });
            void this.flush().then(this.afterFlush);
            void this.flush().finally(() => this.log.debug("done"));
            void this.settle(pending);
          }
          private async settle(pending: Promise<void>[]): Promise<number> {
            const results = await Promise.allSettled(pending);
            return results.length;
          }
          private async flush(): Promise<void> {
            try {
              await this.setStateAsync("x", 1);
            } catch {
              // handled
            }
            return Promise.resolve();
          }
          private afterFlush = async (): Promise<void> => {
            await this.setStateAsync("d", 4);
          };
        }
      `,
    });
    expect(lines()).toEqual([
      "src/main.ts:15 `void … .then(…)` without `.catch(…)`: a rejection of the then-callback (its body has no try/catch — `await this.setStateAsync(\"c\", 3)` can reject) has no receiver",
      "src/main.ts:18 `void … .then(…)` without `.catch(…)`: a rejection of the then-callback (its body has no try/catch — `await this.setStateAsync(\"d\", 4)` can reject) has no receiver",
    ]);
  });

  it("reads own sync helpers that throw, an immediately invoked arrow and a bound method, and stops at a nested function", () => {
    adapter({
      "src/lib/util.ts": `
        export function coerce(value: unknown): number {
          if (typeof value !== "number") {
            throw new Error("not a number");
          }
          return value;
        }
        export function errText(e: unknown): string {
          return e instanceof Error ? e.message : String(e);
        }
      `,
      "src/main.ts": `
        import { coerce, errText } from "./lib/util.js";
        class Main extends utils.Adapter {
          onReady(): void {
            void this.write("1");
            void (async () => {
              await this.setStateAsync("x", 1);
            })();
            void this.later.bind(this)();
          }
          private async write(raw: string): Promise<void> {
            const value = coerce(raw);
            try {
              await this.setStateAsync("y", value);
            } catch (e) {
              this.log.warn(errText(e));
            }
          }
          private async later(): Promise<void> {
            try {
              await this.setStateAsync("z", 1);
            } catch (e) {
              this.log.warn(errText(e));
              const retry = async (): Promise<void> => {
                await this.setStateAsync("z", 1);
              };
              this.retry = retry;
            }
          }
        }
      `,
    });
    expect(lines()).toEqual([
      "src/main.ts:7 an arrow function is dropped with `void` at src/main.ts:6, and its body has no try/catch — `await this.setStateAsync(\"x\", 1)` can reject",
      "src/main.ts:12 `write` is dropped with `void` at src/main.ts:5, and `coerce(raw)` can throw outside its try/catch",
    ]);
  });

  it("reports a callee behind a relative import in the file that declares it, with the call site in the importing file", () => {
    adapter({
      "src/lib/sync.ts": `
        export async function syncAll(write: (id: string) => Promise<void>): Promise<void> {
          await write("a");
        }
        export const settle = async (): Promise<void> => {
          try {
            await Promise.resolve();
          } catch {
            // handled
          }
        };
      `,
      "src/main.ts": `
        import { settle, syncAll as sync } from "./lib/sync.js";
        class Main extends utils.Adapter {
          onReady(): void {
            void sync((id) => this.setStateAsync(id, 1));
            void settle();
          }
        }
      `,
    });
    expect(lines()).toEqual([
      "src/lib/sync.ts:3 `syncAll` is dropped with `void` at src/main.ts:5, and its body has no try/catch — `await write(\"a\")` can reject",
    ]);
  });

  it("does not judge the Admin component, tests or declaration files", () => {
    adapter({
      "src/main.test.ts": "void (async () => { await x(); })();\n",
      "src/types.d.ts": "void (async () => { await x(); })();\n",
      "src-admin/src/App.tsx": "void (async () => { await x(); })();\n",
      "src/main.ts": "export const x = 1;\n",
    });
    expect(lines()).toEqual([]);
  });

  it("reports that the sources could not be judged instead of staying silent", async () => {
    adapter({ "src/main.ts": "export const x = 1;\n" });
    vi.resetModules();
    vi.doMock("../adapter-api.js", () => ({ typescriptApi: () => undefined }));
    const { fireAndForgetRejectionCheck: check } = await import("./fire-and-forget-rejection.js");
    const findings = check.run(dir);
    vi.doUnmock("../adapter-api.js");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("no `typescript` module can be loaded");
  });
});
