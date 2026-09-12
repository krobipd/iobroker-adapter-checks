import type { Check, Finding } from "../types.js";
import { listSourceFiles, readJson, readText, repoPath } from "../util.js";

/**
 * A method declaration in a TypeScript class body: optional modifiers, the name, a
 * parameter list and the `:` of the return type. A method without a declared return type is
 * not recognised — the call inside it is then attributed to the previous recognised method
 * (the python original had the same limit; it can only make the check quieter, never louder).
 *
 * The name class spells out what python's `\w` matches — letters and digits of any script —
 * because JavaScript's `\w` is ASCII only.
 */
const METHOD_DECL =
  /^\s*(?:(?:private|public|protected)\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][\p{L}\p{N}_$]*)\s*\([^)]*\)\s*:/gmu;

/** Keywords that look like a method declaration to the regex above but are none. */
const NOT_A_METHOD = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "constructor",
]);

/**
 * Lifecycle hooks are never called by the adapter itself — they are handed to an event
 * (`this.on("ready", this.onReady.bind(this))`). A call sitting directly in one of them is
 * reachable by definition.
 */
const LIFECYCLE_HOOKS = new Set([
  "onReady",
  "onUnload",
  "onMessage",
  "onStateChange",
  "onObjectChange",
]);

/**
 * A string as a literal inside a regular expression.
 *
 * @param text the literal
 * @returns the text with every metacharacter escaped
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The name of the method whose declaration is the last one before `position`, or undefined
 * for module level and the constructor. A nested function counts as its enclosing method,
 * which can only lead to fewer reports, never to a wrong one.
 *
 * @param source one source file
 * @param position character offset of the call
 * @returns the method name, or undefined
 */
function enclosingMethod(source: string, position: number): string | undefined {
  let holder: string | undefined;
  for (const m of source.matchAll(METHOD_DECL)) {
    if (m.index > position) {
      break;
    }
    const name = m[1];
    if (name !== undefined && !NOT_A_METHOD.has(name)) {
      holder = name;
    }
  }
  return holder;
}

/**
 * Whether `method` occurs anywhere besides its own declaration, across all sources.
 *
 * Deliberately generous rather than precise: a lifecycle hook is handed over, not called, and
 * an adapter may create its objects in a helper class (`this.stateManager.syncObjects()`) —
 * both are valid and must not count as dead code. The real defect looks different: once the
 * only call site is gone, exactly ONE occurrence is left, the declaration.
 *
 * Word boundaries are spelled out (letters and digits of any script, underscore) so that a
 * name next to a non-ASCII character is bounded the way python's `\b` bounds it.
 *
 * @param sources every source file, joined
 * @param method the method name
 * @returns true when the name is referenced at least once besides its declaration
 */
function isReferenced(sources: string, method: string): boolean {
  if (LIFECYCLE_HOOKS.has(method)) {
    return true;
  }
  const word = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(method)}(?![\\p{L}\\p{N}_])`,
    "gu",
  );
  return [...sources.matchAll(word)].length > 1;
}

/**
 * Every object the manifest declares under `instanceObjects` is refreshed at runtime by
 * reachable code.
 *
 * js-controller applies `instanceObjects` on every adapter start (`_createInstancesObjects`
 * → `_extendObjects`, measured on 7.2.2) — but with `preserve: { common: ["name"] }`:
 * `common.desc` reaches an existing installation, `common.name` is frozen to whatever the
 * version that first created the object wrote. A renamed object therefore reaches new
 * installations only, and neither the manifest nor a test shows it; only the real tree of an
 * upgraded installation does.
 *
 * Judged is the structure, never the text: for every `_id` there is an
 * `extendObject("<id>", …)` / `extendObjectAsync("<id>", …)` somewhere below `src/`, and the
 * method holding that call is itself called from somewhere. The second half is not
 * theoretical: dropping just the call line from `onReady` leaves method and call in place,
 * lint and type check stay green, and not a single installation is reached.
 *
 * Objects the adapter creates dynamically are unaffected — they pass through `extendObject`
 * on every start anyway. An adapter without TypeScript sources below `src/` is not judged.
 */
export const instanceObjectsRefreshCheck: Check = {
  id: "instance-objects-refresh",
  title:
    "every manifest object is refreshed with extendObject from code that runs",
  run(adapterDir: string): Finding[] {
    const iopkg = readJson<{ instanceObjects?: unknown }>(
      adapterDir,
      "io-package.json",
    );
    const files = listSourceFiles(adapterDir);
    if (!iopkg || files.length === 0) {
      return [];
    }
    const objects = Array.isArray(iopkg.instanceObjects)
      ? iopkg.instanceObjects
      : [];
    if (objects.length === 0) {
      return [];
    }
    const texts = files.map((file) => ({
      rel: repoPath(adapterDir, file),
      text: readText(adapterDir, repoPath(adapterDir, file)) ?? "",
    }));
    const joined = texts.map((t) => t.text).join("\n");

    const findings: Finding[] = [];
    for (const obj of objects) {
      const id =
        typeof obj === "object" && obj !== null
          ? (obj as { _id?: unknown })._id
          : undefined;
      if (typeof id !== "string" || id === "") {
        continue;
      }
      const call = new RegExp(
        `extendObject(?:Async)?\\(\\s*['"\`]${escapeRegExp(id)}['"\`]`,
      );
      let hit: { rel: string; text: string; index: number } | undefined;
      for (const t of texts) {
        const m = call.exec(t.text);
        if (m) {
          hit = { rel: t.rel, text: t.text, index: m.index };
          break;
        }
      }
      if (!hit) {
        findings.push({
          check: instanceObjectsRefreshCheck.id,
          file: "io-package.json",
          message: `'${id}' is never refreshed with extendObject`,
          impact:
            "js-controller applies instanceObjects on start but preserves common.name — a renamed object keeps its old name on every existing installation (the description does arrive); call extendObject with name and description in onReady",
        });
        continue;
      }
      const holder = enclosingMethod(hit.text, hit.index);
      if (holder !== undefined && !isReferenced(joined, holder)) {
        findings.push({
          check: instanceObjectsRefreshCheck.id,
          file: hit.rel,
          line: hit.text.slice(0, hit.index).split("\n").length,
          message: `'${id}' is refreshed only in ${holder}(), and nothing calls that method`,
          impact:
            "the call is dead code — existing installations keep the old name; call the method from onReady",
        });
      }
    }
    return findings;
  },
};
