import type { Check, Finding } from "../types.js";
import { listTestFiles, readText, repoPath, stripTsComments } from "../util.js";

/**
 * The file replaces `fetch`: a vitest/jest global stub, a spy, or a direct assignment — the
 * forms the fleet's unit tests and inventory fixtures use (`vi.stubGlobal("fetch", …)`,
 * `globalThis.fetch = …` in a `--require` hook, `vi.spyOn(globalThis, "fetch")`).
 */
const STUBS_FETCH =
  /\bstubGlobal\(\s*["']fetch["']|\b(?:globalThis|global|window)\.fetch\s*=(?!=)|\bspyOn\(\s*(?:globalThis|global|window)\s*,\s*["']fetch["']\s*\)/;

/**
 * A hand-built response: an object literal member `json` or `text` whose value is a function
 * (`json: () => …`, `text: async () =>`, `json: vi.fn(…)`, `json() { … }`). A data field
 * (`text: "hello"`) is not a response and does not count.
 */
const RESPONSE_METHOD =
  /(?<![\w$.])(?:json|text)\s*(?::\s*(?:async\s*)?(?:\(|function\b|vi\.fn|jest\.fn)|\(\s*\)\s*\{)/g;

/**
 * 1-based line of a character offset.
 *
 * @param text the file
 * @param index offset into it
 * @returns the line number
 */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * A `fetch` stub returns a real `Response`, never an object that only imitates its methods.
 *
 * Measured 2026-09-16 on a fleet adapter: its unit test and its inventory fixture answered `fetch` with
 * `Promise.resolve({ ok, status, json: () => …, text: () => … })` — an object without `body`, without `headers`,
 * without `clone()`. The production code had started to read the body as a stream (`response.body.getReader()`, a
 * size cap): against the imitation `body` was `undefined`, every request returned an empty string, the inventory run
 * failed with `invalid JSON` — while the fixture looked perfectly healthy. The second half of the same class: the unit
 * test never reached the cap path at all and still reported the rule as tested. Code that falls back to `res.text()`
 * when `body` is missing hides the same gap — the stream path is green without a test ever touching it.
 *
 * `Response` is global in Node ≥ 18 (also inside a `.cjs` fixture): `new Response(body, { status,
 * headers })` carries `ok`, `status`, `headers`, `body`, `json()`, `text()`, `clone()` exactly
 * the way the real thing does, so a test exercises the code path the adapter actually runs.
 *
 * Judged are the test sources (`src/**\/*.test.ts`) and everything below `test/` — a file that
 * stubs `fetch` and contains an object literal with a function-valued `json` or `text` member
 * is reported at that member. A file that builds `new Response(…)` only, or that stubs
 * something else, is not touched. Comments are removed first.
 */
export const fetchStubResponseCheck: Check = {
  id: "fetch-stub-response",
  title:
    "a fetch stub answers with a real Response, not with an object that imitates one",
  run(adapterDir: string): Finding[] {
    const findings: Finding[] = [];
    for (const file of listTestFiles(adapterDir)) {
      const rel = repoPath(adapterDir, file);
      const text = stripTsComments(readText(adapterDir, rel) ?? "");
      if (!STUBS_FETCH.test(text)) {
        continue;
      }
      for (const m of text.matchAll(RESPONSE_METHOD)) {
        findings.push({
          check: fetchStubResponseCheck.id,
          file: rel,
          line: lineOf(text, m.index),
          message:
            "a fetch stub answers with a hand-built object carrying json/text methods instead of a real Response",
          impact:
            "the imitation has no body, headers or clone(): code that reads the stream (response.body.getReader()) sees undefined and the test proves nothing about it (every request returned an empty string while the fixture looked healthy); build new Response(body, { status, headers }) — Node has it globally",
        });
      }
    }
    return findings;
  },
};
