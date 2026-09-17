import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorTextHelperCheck } from "./error-text-helper.js";

describe("error-text-helper", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "error-text-helper-"));
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
    errorTextHelperCheck.run(dir).map((f) => `${f.file}:${f.line ?? 0} ${f.message}`);

  /** The fleet helper's object branch, as a function declaration. */
  const HELPER = `
    export function errText(err: unknown): string {
      if (err instanceof Error) {
        return err.message;
      }
      if (typeof err === "string") {
        return err;
      }
      try {
        return JSON.stringify(err) ?? Object.prototype.toString.call(err);
      } catch {
        return Object.prototype.toString.call(err);
      }
    }
  `;

  it("is silent without src/, and with one helper that the adapter and the Admin component share", () => {
    expect(errorTextHelperCheck.run(dir)).toEqual([]);
    adapter({
      "src/lib/err-text.ts": HELPER,
      "src/main.ts": 'import { errText } from "./lib/err-text.js";\nexport const t = errText;\n',
      "src-admin/src/App.tsx": 'import { errText } from "../../src/lib/err-text.js";\nexport const t = errText;\n',
    });
    expect(lines()).toEqual([]);
  });

  it("reports a copy in the Admin component in a different shape (homeconnect 1.21.0), naming the adapter's own helper", () => {
    adapter({
      "src/lib/pure-helpers.ts": HELPER,
      "src-admin/src/SignIn.tsx": `
        function panelErrText(e: unknown): string {
          const tag = Object.prototype.toString.call(e);
          try {
            return e instanceof Error ? e.message : typeof e === "string" ? e : (JSON.stringify(e) ?? tag);
          } catch {
            return tag;
          }
        }
        export const SignIn = (): string => panelErrText(new Error("x"));
      `,
    });
    expect(lines()).toEqual([
      "src-admin/src/SignIn.tsx:2 `panelErrText` is a second error-text helper — the repository's is `errText` in src/lib/pure-helpers.ts:2",
    ]);
    expect(errorTextHelperCheck.run(dir)[0]?.impact).toContain("`dts: false`");
  });

  it("reports a second copy below src/ too — a method and an arrow property — and keeps the first by path", () => {
    adapter({
      "src/lib/a.ts": HELPER,
      "src/lib/b.ts": `
        export class Renderer {
          text = (e: unknown): string => {
            try {
              return JSON.stringify(e) ?? "";
            } catch {
              return Object.prototype.toString.call(e);
            }
          };
        }
      `,
      "src/main.ts": `
        class Main {
          private describe(e: unknown): string {
            const tag = Object.prototype.toString.call(e);
            return JSON.stringify(e) ?? tag;
          }
        }
      `,
    });
    expect(lines()).toEqual([
      "src/lib/b.ts:3 `text` is a second error-text helper — the repository's is `errText` in src/lib/a.ts:2",
      "src/main.ts:3 `describe` is a second error-text helper — the repository's is `errText` in src/lib/a.ts:2",
    ]);
  });

  it("counts the innermost function that carries both calls, not the component that defines it", () => {
    adapter({
      "src/lib/a.ts": HELPER,
      "src-admin/src/App.tsx": `
        export function App(): string {
          const render = (e: unknown): string => {
            try {
              return JSON.stringify(e) ?? Object.prototype.toString.call(e);
            } catch {
              return Object.prototype.toString.call(e);
            }
          };
          return render(1);
        }
      `,
    });
    expect(lines()).toEqual([
      "src-admin/src/App.tsx:3 `render` is a second error-text helper — the repository's is `errText` in src/lib/a.ts:2",
    ]);
  });

  it("does not count a function with only one of the two calls, or a call in a test or declaration file", () => {
    adapter({
      "src/lib/a.ts": HELPER,
      "src/lib/json.ts": "export const dump = (v: unknown): string => JSON.stringify(v) ?? '';\n",
      "src/lib/tag.ts": "export const tag = (v: unknown): string => Object.prototype.toString.call(v);\n",
      "src/lib/a.test.ts": HELPER,
      "src/lib/a.d.ts": HELPER,
    });
    expect(lines()).toEqual([]);
  });

  it("reports that the sources could not be judged instead of staying silent", async () => {
    adapter({ "src/main.ts": "export const x = 1;\n" });
    vi.resetModules();
    vi.doMock("../adapter-api.js", () => ({ typescriptApi: () => undefined }));
    const { errorTextHelperCheck: check } = await import("./error-text-helper.js");
    const findings = check.run(dir);
    vi.doUnmock("../adapter-api.js");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("no `typescript` module can be loaded");
  });
});
