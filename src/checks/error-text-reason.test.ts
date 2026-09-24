import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorTextReasonCheck } from "./error-text-reason.js";

describe("error-text-reason", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "error-text-reason-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Files by repository path (`src/…`, `src-admin/src/…`). */
  const adapter = (files: Record<string, string>): void => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
  };

  const lines = (): string[] =>
    errorTextReasonCheck.run(dir).map((f) => `${f.file}:${f.line ?? 0} ${f.message}`);

  /** The helper's non-Error branches, shared by every shape below (inside its `try`). */
  const REST = `
      if (typeof err === "string") {
        return err;
      }
      if (typeof err === "function") {
        return Object.prototype.toString.call(err);
      }
      if (err === null || err === undefined || typeof err !== "object") {
        return String(err);
      }
      return JSON.stringify(err) ?? Object.prototype.toString.call(err);
  `;

  /** A helper whose whole body sits in a `try`, with `branch` as its Error branch. */
  const guarded = (head: string, branch: string, tail = "}"): string => `
    ${head}
      try {
        if (err instanceof Error) {
          ${branch}
        }
        ${REST}
      } catch {
        return Object.prototype.toString.call(err);
      }
    ${tail}
  `;

  /** The Error branch of the master form: message, code for an empty one, one level of cause. */
  const MASTER_BRANCH = `
        const code = "code" in err ? err.code : undefined;
        const message: unknown = err.message;
        const name: unknown = err.name;
        const text = String(message || (typeof code === "string" ? code : name));
        const cause = err.cause;
        let reason = "";
        if (cause instanceof Error) {
          const causeCode = "code" in cause ? cause.code : undefined;
          const causeMessage: unknown = cause.message;
          reason =
            (typeof causeMessage === "string" ? causeMessage : "") ||
            (typeof causeCode === "string" ? causeCode : "");
        } else if (cause !== undefined && cause !== null) {
          reason = errText(cause);
        }
        return reason && !text.includes(reason) ? \`\${text} (\${reason})\` : text;
  `;

  /** The master form (CLAUDE_PATTERNS.md). */
  const MASTER = guarded("export function errText(err: unknown): string {", MASTER_BRANCH);

  /** The master form with one passage replaced — the passage must be there. */
  const swap = (from: string, to: string): string => {
    expect(MASTER).toContain(from);
    return MASTER.replace(from, to);
  };

  it("is silent without src/, without a helper, and for the master form", () => {
    expect(errorTextReasonCheck.run(dir)).toEqual([]);
    adapter({ "src/main.ts": "export const x = 1;\n" });
    expect(lines()).toEqual([]);
    adapter({ "src/lib/err-text.ts": MASTER });
    expect(lines()).toEqual([]);
  });

  it("accepts the cause read by destructuring", () => {
    adapter({
      "src/lib/err-text.ts": guarded(
        "export const errText = (err: unknown): string => {",
        `
            const { cause, code } = err as Error & { code?: string };
            const text = err.message || code || err.name;
            return cause === undefined ? text : \`\${text} (\${errText(cause)})\`;
        `,
        "};",
      ),
    });
    expect(lines()).toEqual([]);
  });

  it("accepts cause and code destructured under another name", () => {
    adapter({
      "src/lib/err-text.ts": guarded(
        "export function errText(err: unknown): string {",
        `
            const { cause: why, code: c } = err as Error & { code?: string };
            const text = err.message || c || err.name;
            return why === undefined ? text : \`\${text} (\${errText(why)})\`;
        `,
      ),
    });
    expect(lines()).toEqual([]);
  });

  it("reports the helper that renders an Error as its message alone — both parts, at the helper", () => {
    adapter({
      "src/lib/pure-helpers.ts": guarded(
        "export function errMessage(err: unknown): string {",
        "return err.message;",
      ),
    });
    expect(lines()).toEqual([
      "src/lib/pure-helpers.ts:2 the error-text helper `errMessage` never reads `.cause`: an Error's text is its message alone, and Node's `fetch` rejects every network failure as `TypeError: fetch failed` with the reason only in the cause (`getaddrinfo ENOTFOUND host`, `connect ECONNREFUSED 10.0.0.2:80`, `other side closed`) — the log line says `fetch failed` and nothing else",
      "src/lib/pure-helpers.ts:2 the error-text helper `errMessage` never reads `.code`: an Error with an empty message renders as nothing — `http.get` and `net.connect` to `localhost` reject with an `AggregateError` whose message is `\"\"` and whose reason is `code: \"ECONNREFUSED\"` (for `fetch` that AggregateError is the cause)",
    ]);
    expect(errorTextReasonCheck.run(dir)[0]?.impact).toContain("one level deep");
  });

  it("reports the missing part only", () => {
    adapter({
      "src/lib/err-text.ts": guarded(
        "export function errText(err: unknown): string {",
        "return err.cause === undefined ? err.message : \`\${err.message} (\${errText(err.cause)})\`;",
      ),
    });
    expect(lines().map((l) => l.split(":")[0] + " " + (l.includes("`.code`") ? "code" : "cause"))).toEqual([
      "src/lib/err-text.ts code",
    ]);
  });

  /** The master form of 0.15 and earlier: no `try` around the body, functions go to `String()`. */
  const MASTER_0_15 = `
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
      if (typeof err === "string") {
        return err;
      }
      if (err === null || err === undefined || typeof err !== "object") {
        return String(err);
      }
      try {
        return JSON.stringify(err) ?? Object.prototype.toString.call(err);
      } catch {
        return Object.prototype.toString.call(err);
      }
    }
  `;

  it("reports the master form of 0.15: a function goes to String(), the properties are read outside a try", () => {
    adapter({ "src/lib/err-text.ts": MASTER_0_15 });
    expect(lines()).toEqual([
      'src/lib/err-text.ts:2 the error-text helper `errText` never tests `typeof … === "function"`: a thrown function or class falls into the branch for primitives, and `String()` renders its whole source text into the log',
      "src/lib/err-text.ts:2 the error-text helper `errText` reads `.code`, `.message`, `.name`, `.cause` outside a `try`: it runs inside a `catch`, and a getter that throws or a `message` that is not a string (`text.includes(…)` on a number) makes the catch block throw a second time — the error it was handed never reaches the log, and the new one escapes the handler",
    ]);
    expect(errorTextReasonCheck.run(dir)[0]?.impact).toContain("type tag");
  });

  it("accepts the function test in every spelling", () => {
    for (const test of [
      'typeof err === "function"',
      '"function" === typeof err',
      "typeof err == 'function'",
    ]) {
      adapter({
        "src/lib/err-text.ts": swap('typeof err === "function"', test),
      });
      expect(lines(), test).toEqual([]);
    }
    adapter({
      "src/lib/err-text.ts": swap(
        'if (typeof err === "function") {\n        return Object.prototype.toString.call(err);\n      }',
        'switch (typeof err) {\n        case "function":\n          return Object.prototype.toString.call(err);\n      }',
      ),
    });
    expect(lines()).toEqual([]);
  });

  it("does not take a typeof test against another type, or a plain string, for the function test", () => {
    adapter({
      "src/lib/err-text.ts": swap(
        'if (typeof err === "function") {',
        'if (typeof err === "symbol" || err === "function") {',
      ),
    });
    expect(lines()).toEqual([
      'src/lib/err-text.ts:2 the error-text helper `errText` never tests `typeof … === "function"`: a thrown function or class falls into the branch for primitives, and `String()` renders its whole source text into the log',
    ]);
    adapter({
      "src/lib/err-text.ts": swap(
        'if (typeof err === "function") {\n        return Object.prototype.toString.call(err);\n      }',
        'switch (err) {\n        case "function":\n          return Object.prototype.toString.call(err);\n      }',
      ),
    });
    expect(lines()).toEqual([
      'src/lib/err-text.ts:2 the error-text helper `errText` never tests `typeof … === "function"`: a thrown function or class falls into the branch for primitives, and `String()` renders its whole source text into the log',
    ]);
  });

  it("counts a read in the catch clause or the finally block as outside the try, and names each property once", () => {
    adapter({
      "src/lib/err-text.ts": swap(
        "return Object.prototype.toString.call(err);\n      }\n    }",
        "return err instanceof Error ? err.name : Object.prototype.toString.call(err);\n      } finally {\n        void (err as Error).cause;\n        void (err as Error).cause;\n      }\n    }",
      ),
    });
    expect(lines().map((l) => l.split(" outside")[0])).toEqual([
      "src/lib/err-text.ts:2 the error-text helper `errText` reads `.name`, `.cause`",
    ]);
  });

  it("sees a destructured read outside the try", () => {
    adapter({
      "src/lib/err-text.ts": swap(
        "try {",
        "const { code: early } = err as { code?: unknown };\n      void early;\n      try {",
      ),
    });
    expect(lines().map((l) => l.split(" outside")[0])).toEqual([
      "src/lib/err-text.ts:2 the error-text helper `errText` reads `.code`",
    ]);
  });

  it("judges the repository's helper, not an Admin copy (error-text-helper reports that one)", () => {
    adapter({
      "src/lib/err-text.ts": MASTER,
      "src-admin/src/SignIn.tsx": `
        function panelErrText(e: unknown): string {
          const tag = Object.prototype.toString.call(e);
          try {
            return e instanceof Error ? e.message : typeof e === "string" ? e : (JSON.stringify(e) ?? tag);
          } catch {
            return tag;
          }
        }
        export const x = panelErrText;
      `,
    });
    expect(lines()).toEqual([]);
  });
});

describe("error-text-reason without a compiler", () => {
  it("reports that the sources could not be judged instead of staying silent", async () => {
    vi.resetModules();
    vi.doMock("../adapter-api.js", () => ({
      typescriptApi: () => undefined,
    }));
    const { errorTextReasonCheck: check } = await import("./error-text-reason.js");
    const dir = mkdtempSync(join(tmpdir(), "error-text-reason-nocompiler-"));
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
