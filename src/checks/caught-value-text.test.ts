import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caughtValueTextCheck } from "./caught-value-text.js";

describe("caught-value-text", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caught-value-text-"));
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
    caughtValueTextCheck.run(dir).map((f) => `${f.file}:${f.line ?? 0} ${f.message}`);

  /** The fleet helper: every thrown value has a branch, an Error says its reason. */
  const HELPER = `
    export function errText(err: unknown): string {
      if (err instanceof Error) {
        const code = "code" in err ? err.code : undefined;
        const text = err.message || (typeof code === "string" ? code : err.name);
        const cause = err.cause;
        let reason = "";
        if (cause instanceof Error) {
          const causeCode = "code" in cause ? cause.code : undefined;
          reason = cause.message || (typeof causeCode === "string" ? causeCode : "");
        } else if (cause !== undefined && cause !== null) {
          reason = errText(cause);
        }
        return reason && !text.includes(reason) ? \`\${text} (\${reason})\` : text;
      }
      if (err === null) {
        return "null";
      }
      if (err === undefined) {
        return "undefined";
      }
      if (typeof err === "string") {
        return err;
      }
      if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
        return String(err);
      }
      if (typeof err === "symbol") {
        return err.toString();
      }
      try {
        return JSON.stringify(err) ?? Object.prototype.toString.call(err);
      } catch {
        return Object.prototype.toString.call(err);
      }
    }
  `;

  it("is silent without src/", () => {
    expect(caughtValueTextCheck.run(dir)).toEqual([]);
  });

  it("accepts the fleet helper and catch sites that use it", () => {
    adapter({
      "lib/coerce.ts": HELPER,
      "main.ts": `
        import { errText } from "./lib/coerce.js";
        export async function start(log: { error(m: string): void }): Promise<void> {
          try {
            await connect();
          } catch (err) {
            log.error(\`start failed: \${errText(err)}\`);
            throw new Error(errText(err));
          }
          connect().catch((e) => log.error(errText(e)));
        }
      `,
    });
    expect(caughtValueTextCheck.run(dir)).toEqual([]);
  });

  it("accepts the other two fleet forms: the primitive branch as one typeof, and the object branch as a try that returns", () => {
    adapter({
      "lib/a.ts": `
        export function errorText(err: unknown): string {
          if (err instanceof Error) {
            const { cause } = err;
            return (err.message || err.name || "Error") + (cause === undefined ? "" : \` (\${errorText(cause)})\`);
          }
          if (typeof err === "string") {
            return err;
          }
          if (err === null || err === undefined || typeof err !== "object") {
            return String(err);
          }
          let json: string | undefined;
          try {
            json = JSON.stringify(err);
          } catch {
            json = undefined;
          }
          return json ?? Object.prototype.toString.call(err);
        }
      `,
      "lib/b.ts": `
        export function errMessage(e: unknown): string {
          if (e instanceof Error) {
            return e.cause === undefined ? e.message : \`\${e.message} (\${errMessage(e.cause)})\`;
          }
          if (typeof e === "object" && e !== null) {
            try {
              return JSON.stringify(e) ?? Object.prototype.toString.call(e);
            } catch {
              return Object.prototype.toString.call(e);
            }
          }
          return String(e);
        }
      `,
      "main.ts": `
        import { errorText } from "./lib/a.js";
        import { errMessage } from "./lib/b.js";
        export function f(log: (m: string) => void): void {
          try {
            run();
          } catch (e) {
            log(errorText(e));
            log(errMessage(e));
          }
        }
      `,
    });
    expect(caughtValueTextCheck.run(dir)).toEqual([]);
  });

  describe("the inline forms", () => {
    it("reports the ternary's String() branch and its `.message` branch", () => {
      adapter({
        "main.ts": `
          export function f(log: (m: string) => void): void {
            try {
              run();
            } catch (err) {
              log(\`onReady failed: \${err instanceof Error ? err.message : String(err)}\`);
            }
          }
        `,
      });
      expect(lines()).toEqual([
        "src/main.ts:6 the caught value `err` is rendered through its `.message`: an Error's reason is lost (`fetch` rejects every network failure as `fetch failed`, the reason only in `cause`; `http.get` to `localhost` rejects with an empty message and the reason in `code`), and a thrown string or plain object has no `message` at all",
        "src/main.ts:6 the caught value `err` is rendered with String(): a thrown plain object (a rejected `{ code: \"ECONNRESET\" }`, an HTTP client's error object) becomes `[object Object]`",
      ]);
      expect(caughtValueTextCheck.run(dir)[0]?.impact).toContain("route every caught value through one helper");
    });

    it("reports String() on its own, also when it feeds a new Error", () => {
      adapter({
        "main.ts": `
          export function f(log: (m: string) => void, reject: (e: Error) => void): void {
            try {
              run();
            } catch (err) {
              log(\`failed: \${String(err)}\`);
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          }
        `,
      });
      expect(lines().map((l) => l.split(" ")[0])).toEqual(["src/main.ts:6", "src/main.ts:7"]);
    });

    it("reports `+` into text, `+=` and .toString() (0.15.0)", () => {
      // tooling audit 2026-09-24 (P5): none of the three was seen
      adapter({
        "main.ts": `
          export function f(log: (m: string) => void): void {
            let text = "";
            try {
              run();
            } catch (err) {
              log("failed: " + err);
              text += err;
              log(err.toString());
              log(("a" + (1 + 2)) + err + "!");
            }
          }
        `,
      });
      expect(lines().map((l) => l.split(" ")[0])).toEqual(["src/main.ts:7", "src/main.ts:8", "src/main.ts:9", "src/main.ts:10"]);
      expect(lines()[0]).toContain("`+`");
      expect(lines()[2]).toContain(".toString()");
    });

    it("a numeric `+` and a .toString(radix) are not text of the caught value", () => {
      adapter({
        "main.ts": `
          export function f(log: (m: string) => void): void {
            try {
              run();
            } catch (err) {
              const n = (err as number) + 1;
              log(errText(err));
            }
          }
        `,
      });
      expect(lines().filter((l) => l.includes("`+`"))).toEqual([]);
    });

    it("reports a template literal substitution", () => {
      adapter({
        "main.ts": `
          export function f(log: (m: string) => void): void {
            try {
              run();
            } catch (error) {
              log(\`failed: \${error}\`);
            }
          }
        `,
      });
      expect(lines()).toEqual([
        "src/main.ts:6 the caught value `error` is rendered inside a template literal: a thrown plain object becomes `[object Object]`, a thrown symbol throws again",
      ]);
    });

    it("reports the template's cast, in both assertion syntaxes", () => {
      adapter({
        "main.ts": `
          export function f(log: (m: string) => void): void {
            try {
              run();
            } catch (error) {
              log(\`Error during unloading: \${(error as Error).message}\`);
              log((<Error>error).message);
            }
          }
        `,
      });
      expect(lines()).toEqual([
        "src/main.ts:6 the caught value `error` is read as `(… as Error).message`: a thrown string or plain object has no `message`, the text says `undefined`",
        "src/main.ts:7 the caught value `error` is read as `(… as Error).message`: a thrown string or plain object has no `message`, the text says `undefined`",
      ]);
    });

    it("reports JSON.stringify outside try/catch and accepts it inside", () => {
      adapter({
        "main.ts": `
          export function f(log: (m: string) => void): void {
            try {
              run();
            } catch (err) {
              log(\`bare: \${JSON.stringify(err)}\`);
              try {
                log(\`guarded: \${JSON.stringify(err) ?? Object.prototype.toString.call(err)}\`);
              } catch {
                log(Object.prototype.toString.call(err));
              }
            }
          }
        `,
      });
      expect(lines()).toEqual([
        "src/main.ts:6 the caught value `err` is passed to JSON.stringify outside try/catch: a circular structure (an error carrying the response it came from) throws inside the catch block, and a symbol yields undefined",
      ]);
    });

    it("does not let a try around a callback's definition cover the callback's JSON.stringify", () => {
      adapter({
        "main.ts": `
          export function f(log: (m: string) => void, later: (cb: () => void) => void): void {
            try {
              run();
            } catch (err) {
              try {
                later(() => log(JSON.stringify(err)));
              } catch {
                log("never for the callback");
              }
            }
          }
        `,
      });
      expect(lines().map((l) => l.split(" ")[0])).toEqual(["src/main.ts:7"]);
    });

    it("judges the Admin component's sources under src-admin/src, .tsx included", () => {
      mkdirSync(join(dir, "src-admin", "src"), { recursive: true });
      writeFileSync(
        join(dir, "src-admin", "src", "useDeviceList.tsx"),
        `
          export function useDeviceList(socket: { sendTo(): Promise<unknown> }) {
            return socket.sendTo().catch((e) => {
              throw new Error(e instanceof Error ? e.message : String(e));
            });
          }
          export const Panel = (load: () => unknown) => {
            try {
              return <div>{String(load())}</div>;
            } catch (e) {
              return <div className="error">{String(e)}</div>;
            }
          };
        `,
      );
      writeFileSync(join(dir, "src-admin", "src", "useDeviceList.test.tsx"), `try { run(); } catch (e) { String(e); }`);
      expect(lines().map((l) => l.split(" ")[0])).toEqual([
        "src-admin/src/useDeviceList.tsx:4",
        "src-admin/src/useDeviceList.tsx:4",
        "src-admin/src/useDeviceList.tsx:11",
      ]);
    });
  });

  describe("where caught values come from", () => {
    it("follows .catch() and .then(_, …) callbacks, also a class method and a bound function", () => {
      adapter({
        "main.ts": `
          function onFail(e: unknown): void {
            console.log(String(e));
          }
          function onFailBound(e: unknown): void {
            console.log(String(e));
          }
          export class Main {
            log = (m: string): void => console.log(m);
            start(): void {
              run().catch((e) => this.log(\`a: \${e}\`));
              run().then(() => undefined, (e: unknown) => this.log(\`b: \${e}\`));
              run().catch(this.onError);
              run().catch(this.onOther.bind(this));
              run().catch(onFail);
              run().catch(onFailBound.bind(null));
            }
            private onError(err: unknown): void {
              this.log(\`c: \${String(err)}\`);
            }
            private onOther = (err: unknown): void => {
              this.log(\`d: \${String(err)}\`);
            };
          }
        `,
      });
      expect(lines().map((l) => l.split(" ")[0])).toEqual([
        "src/main.ts:3",
        "src/main.ts:6",
        "src/main.ts:11",
        "src/main.ts:12",
        "src/main.ts:19",
        "src/main.ts:22",
      ]);
      expect(lines()[0]).toContain("the parameter `e` of `onFail` (which receives the rejection handler at src/main.ts:15)");
      expect(lines()[1]).toContain("the parameter `e` of `onFailBound` (which receives the rejection handler at src/main.ts:16)");
      expect(lines()[5]).toContain("the parameter `err` of `onOther` (which receives the rejection handler at src/main.ts:14)");
    });

    it("follows an import also when the adapter directory is given relative", () => {
      adapter({
        "lib/errors.ts": `
          export function errText(e: unknown): string {
            return String(e);
          }
        `,
        "main.ts": `
          import { errText } from "./lib/errors";
          export function f(log: (m: string) => void): void {
            try {
              run();
            } catch (e) {
              log(errText(e));
            }
          }
        `,
      });
      expect(
        caughtValueTextCheck.run(relative(process.cwd(), dir)).map((f) => `${f.file}:${f.line ?? 0}`),
      ).toEqual(["src/lib/errors.ts:3"]);
    });

    it("follows the value into a helper in another file and names the helper and the call site", () => {
      adapter({
        "lib/errors.ts": `
          export function errText(e: unknown): string {
            return e instanceof Error ? e.message : String(e);
          }
        `,
        "lib/one-line.ts": `
          export function oneLine(s: string): string { return s.trim(); }
          export function errText(err: unknown): string {
            if (err instanceof Error) {
              return oneLine(err.message);
            }
            if (typeof err === "string") {
              return oneLine(err);
            }
            return oneLine(String(err));
          }
        `,
        "main.ts": `
          import { errText } from "./lib/errors.js";
          import { errText as text } from "./lib/one-line.js";
          export function f(log: (m: string) => void): void {
            try {
              run();
            } catch (e) {
              log(errText(e));
              log(text(e));
            }
          }
        `,
      });
      expect(lines().map((l) => l.split(" is rendered")[0])).toEqual([
        "src/lib/errors.ts:3 the parameter `e` of `errText` (which receives the caught value `e` at src/main.ts:8)",
        "src/lib/errors.ts:3 the parameter `e` of `errText` (which receives the caught value `e` at src/main.ts:8)",
        "src/lib/one-line.ts:5 the parameter `err` of `errText` (which receives the caught value `e` at src/main.ts:9)",
        "src/lib/one-line.ts:10 the parameter `err` of `errText` (which receives the caught value `e` at src/main.ts:9)",
      ]);
      expect(lines().filter((l) => l.includes("String()"))).toEqual([
        "src/lib/errors.ts:3 the parameter `e` of `errText` (which receives the caught value `e` at src/main.ts:8) is rendered with String(): a thrown plain object (a rejected `{ code: \"ECONNRESET\" }`, an HTTP client's error object) becomes `[object Object]`",
        "src/lib/one-line.ts:10 the parameter `err` of `errText` (which receives the caught value `e` at src/main.ts:9) is rendered with String(): a thrown plain object (a rejected `{ code: \"ECONNRESET\" }`, an HTTP client's error object) becomes `[object Object]`",
      ]);
    });

    it("follows a helper that hands the value on to a second helper", () => {
      adapter({
        "lib/errors.ts": `
          function render(x: unknown): string {
            return \`<\${x}>\`;
          }
          export function errText(e: unknown): string {
            return render(e);
          }
        `,
        "main.ts": `
          import { errText } from "./lib/errors.js";
          export function f(log: (m: string) => void): void {
            try {
              run();
            } catch (e) {
              log(errText(e));
            }
          }
        `,
      });
      expect(lines().map((l) => l.split(" ")[0])).toEqual(["src/lib/errors.ts:3"]);
    });

    it("does not judge a helper nobody calls with a caught value, nor a value that is not caught", () => {
      adapter({
        "lib/format.ts": `
          export function label(v: unknown): string {
            return String(v);
          }
        `,
        "main.ts": `
          import { label } from "./lib/format.js";
          export function f(log: (m: string) => void, state: { val: unknown }): void {
            log(label(state.val));
            log(\`value \${state.val} \${String(state.val)}\`);
          }
        `,
      });
      expect(caughtValueTextCheck.run(dir)).toEqual([]);
    });
  });

  describe("copies of the caught value", () => {
    it("follows a copy declared through a cast and reports .message off it, and follows a plain copy into String()", () => {
      // hassemu 1.44.0: `const err = error as Error; log(err.message)` at four sites — 0.11.x saw only
      // the direct `(error as Error).message`.
      adapter({
        "main.ts": `
          export function run(log: { warn: (t: string) => void }): void {
            try {
              work();
            } catch (error) {
              const err = error as Error;
              log.warn(\`stopped: \${err.message}\`);
            }
            try {
              work();
            } catch (error) {
              const copy = error;
              log.warn(String(copy));
            }
            try {
              work();
            } catch (error) {
              const e = <Error>error;
              log.warn(e.message);
            }
          }
          function work(): void {}
        `,
      });
      expect(lines()).toEqual([
        "src/main.ts:7 the caught value `error` (as `err`) is read as `(… as Error).message`: a thrown string or plain object has no `message`, the text says `undefined`",
        "src/main.ts:13 the caught value `error` (as `copy`) is rendered with String(): a thrown plain object (a rejected `{ code: \"ECONNRESET\" }`, an HTTP client's error object) becomes `[object Object]`",
        "src/main.ts:19 the caught value `error` (as `e`) is read as `(… as Error).message`: a thrown string or plain object has no `message`, the text says `undefined`",
      ]);
    });

    it("does not follow a copy taken where a guard already proves an Error or rules an object out", () => {
      adapter({
        "main.ts": `
          export function run(log: { warn: (t: string) => void }): void {
            try {
              work();
            } catch (error) {
              if (error instanceof Error) {
                const err = error as Error;
                log.warn(err.message);
              }
              if (typeof error !== "object") {
                const text = error;
                log.warn(String(text));
              }
            }
          }
          function work(): void {}
        `,
      });
      expect(lines()).toEqual([]);
    });
  });

  describe("the rejection reasons of Promise.allSettled", () => {
    it("reports String() on `r.reason` of a settled result — from a .then() callback and from an awaited list", () => {
      // hassemu 1.44.0 onUnload: `for (const r of results) if (r.status === "rejected") log(String(r.reason))`.
      adapter({
        "main.ts": `
          export async function stop(pending: Promise<void>[], log: { error: (t: string) => void }): Promise<void> {
            void Promise.allSettled(pending).then((results) => {
              for (const r of results) {
                if (r.status === "rejected") {
                  log.error(\`Shutdown error: \${String(r.reason)}\`);
                }
              }
            });
            const settled = await Promise.allSettled(pending);
            settled.forEach((result) => {
              if (result.status === "rejected") {
                log.error(\`failed: \${result.reason}\`);
              }
            });
            for (const r of settled) {
              if (r.status === "rejected") {
                const reason = r.reason;
                log.error(text(reason));
              }
            }
          }
          function text(e: unknown): string {
            return String(e);
          }
        `,
      });
      expect(lines()).toEqual([
        "src/main.ts:6 the rejection reason `r.reason` (Promise.allSettled at src/main.ts:3) is rendered with String(): a thrown plain object (a rejected `{ code: \"ECONNRESET\" }`, an HTTP client's error object) becomes `[object Object]`",
        "src/main.ts:13 the rejection reason `result.reason` (Promise.allSettled at src/main.ts:10) is rendered inside a template literal: a thrown plain object becomes `[object Object]`, a thrown symbol throws again",
        "src/main.ts:24 the parameter `e` of `text` (which receives the rejection reason `r.reason` (Promise.allSettled at src/main.ts:10) (as `reason`) at src/main.ts:19) is rendered with String(): a thrown plain object (a rejected `{ code: \"ECONNRESET\" }`, an HTTP client's error object) becomes `[object Object]`",
      ]);
    });

    it("accepts a reason rendered where a guard rules an object out, and does not follow the list into anything but an element", () => {
      adapter({
        "main.ts": `
          export async function stop(pending: Promise<void>[], log: { error: (t: string) => void }): Promise<void> {
            const settled = await Promise.allSettled(pending);
            for (const r of settled) {
              if (r.status === "rejected" && typeof r.reason === "string") {
                log.error(String(r.reason));
              }
            }
            log.error(String(settled.length));
          }
        `,
      });
      expect(lines()).toEqual([]);
    });
  });

  describe("guards that make a rendering safe", () => {
    it("accepts String() and a template where the value cannot be an object, in a branch or after an early return", () => {
      adapter({
        "main.ts": `
          export function f(log: (m: string) => void): void {
            try {
              run();
            } catch (e) {
              if (typeof e !== "object") {
                log(String(e));
              }
              if (typeof e === "string" || typeof e === "number") {
                log(\`\${e}\`);
              }
              if (e instanceof Error) {
                log(\`\${e}\`);
                log((e as Error).message);
              }
              if (e === null || e === undefined) {
                log(String(e));
              }
              if (!e) {
                log(String(e));
              }
              log(typeof e === "object" && e !== null ? "object" : String(e));
              log(typeof e === "object" ? "object" : \`\${e}\`);
              if (typeof e === "object" && e !== null) {
                return;
              }
              log(String(e));
            }
          }
        `,
      });
      expect(caughtValueTextCheck.run(dir)).toEqual([]);
    });

    it("does not accept a guard that still admits an object", () => {
      adapter({
        "main.ts": `
          export function f(log: (m: string) => void): void {
            try {
              run();
            } catch (e) {
              if (!(e instanceof Error)) {
                log(String(e));
              }
              if (typeof e !== "string") {
                log(\`\${e}\`);
              }
              if (e instanceof Error) {
                return;
              }
              log(String(e));
              log(typeof e === "string" ? e : String(e));
              log(typeof e === "object" ? (e as Error).message : "");
              if (typeof e === "string" || isSomething(e)) {
                log(String(e));
              }
              log(typeof e === "object" && isSomething(e) ? "known" : String(e));
            }
          }
        `,
      });
      expect(lines().map((l) => l.split(" ")[0])).toEqual([
        "src/main.ts:7",
        "src/main.ts:10",
        "src/main.ts:15",
        "src/main.ts:16",
        "src/main.ts:17",
        "src/main.ts:19",
        "src/main.ts:21",
      ]);
    });

    it("stops at a parameter that shadows the caught name and reports a nested catch once", () => {
      adapter({
        "main.ts": `
          export function f(log: (m: string) => void, items: unknown[]): void {
            try {
              run();
            } catch (e) {
              items.map((e) => String(e));
              try {
                run();
              } catch (e) {
                log(String(e));
              }
            }
          }
        `,
      });
      expect(lines().map((l) => l.split(" ")[0])).toEqual(["src/main.ts:10"]);
    });
  });

  it("treats the parameter of an \"error\" event listener as a caught value (hassemu mdns.ts:72)", () => {
    adapter({
      "main.ts": `
        import { EventEmitter } from "node:events";
        export function watch(em: EventEmitter, log: { warn(msg: string): void }): void {
          em.on("error", (err: Error) => log.warn(\`mdns failed: \${err.message}\`));
          em.once("error", (e: unknown) => log.warn(String(e)));
          em.on("data", (chunk: Error) => log.warn(chunk.message));
        }`,
    });
    const found = lines();
    expect(found.map((l) => l.split(" ")[0])).toEqual(["src/main.ts:4", "src/main.ts:5"]);
    expect(found[0]).toContain("the \"error\" listener at src/main.ts:4");
    expect(found.join("\n")).not.toContain("chunk");
  });
});

describe("caught-value-text — an Error's `.message` shown as text", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caught-value-text-message-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (main: string): string[] => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.ts"), main);
    return caughtValueTextCheck.run(dir).map((f) => `${f.line ?? 0} ${f.message.split(" is rendered")[1]?.slice(0, 20) ?? f.message}`);
  };

  it("reports every place a proven Error's message is shown — the guard no longer makes it safe", () => {
    expect(
      run(`
        declare const log: { warn(m: string): void };
        export async function f(): Promise<unknown> {
          try {
            await fetch("http://x.invalid/");
          } catch (e) {
            if (e instanceof Error) {
              log.warn(\`a: \${e.message}\`);
              log.warn("b: " + e.message);
              log.warn(e.message);
              const alias = e;
              log.warn(alias.message);
              throw new Error(e.message);
            }
          }
          fetch("x").catch((e) => log.warn(e.message ?? "?"));
          fetch("x").catch((e) => ({ error: e.message }));
          fetch("x").catch((e) => [e.message]);
          try {
            await fetch("y");
          } catch (e) {
            return e instanceof Error ? e.message : "unknown";
          }
          return undefined;
        }
      `),
    ).toEqual([
      "8  through its `.messa",
      "9  through its `.messa",
      "10  through its `.messa",
      "12  through its `.messa",
      "13  through its `.messa",
      "16  through its `.messa",
      "17  through its `.messa",
      "18  through its `.messa",
      "22  through its `.messa",
    ]);
  });

  it("is silent where the message is tested, compared or kept, and where the same function reads the cause", () => {
    expect(
      run(`
        declare const log: { warn(m: string): void };
        declare function errText(e: unknown): string;
        export async function f(): Promise<void> {
          try {
            await fetch("http://x.invalid/");
          } catch (e) {
            if (e instanceof Error) {
              if (e.message.includes("401")) return;
              if (/timeout/.test(e.message)) return;
              if (e.message === "aborted" || !e.message) return;
              if (["a", "b"].includes(e.message)) return;
              const kept = e.message;
              void kept;
            }
          }
          try {
            await fetch("http://y.invalid/");
          } catch (e) {
            if (e instanceof Error) {
              log.warn(\`\${e.message} (\${errText(e.cause)})\`);
            }
          }
          fetch("x").catch((err) => {
            const { cause } = err;
            log.warn(err.message + String(cause));
          });
        }
      `).filter((l) => l.includes("`.messa")),
    ).toEqual([]);
  });

  it("counts a cause read only in the catch block or function of the rendering, not in a sibling", () => {
    expect(
      run(`
        declare const log: { warn(m: string): void };
        declare function errText(e: unknown): string;
        export function f(): void {
          try {
            run();
          } catch (e) {
            if (e instanceof Error) log.warn(errText(e.cause));
          }
          try {
            run();
          } catch (e) {
            if (e instanceof Error) log.warn(e.message);
          }
        }
      `).filter((l) => l.includes("`.messa")),
    ).toEqual(["13  through its `.messa"]);
  });

  it("keeps a proven Error's copy safe for the other forms", () => {
    expect(
      run(`
        declare const log: { warn(m: string): void };
        export function f(): void {
          try {
            run();
          } catch (e) {
            if (e instanceof Error) {
              const err = e;
              log.warn(String(err));
              log.warn(\`\${err}\`);
            }
          }
        }
      `),
    ).toEqual([]);
  });
});

describe("caught-value-text without a compiler", () => {
  it("reports that the sources could not be judged instead of staying silent", async () => {
    vi.resetModules();
    vi.doMock("../adapter-api.js", () => ({
      typescriptApi: () => undefined,
    }));
    const { caughtValueTextCheck: check } = await import("./caught-value-text.js");
    const dir = mkdtempSync(join(tmpdir(), "caught-value-text-nocompiler-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "main.ts"), "export const x = 1;\n");
      const findings = check.run(dir);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("no `typescript` module can be loaded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.doUnmock("../adapter-api.js");
      vi.resetModules();
    }
  });
});
