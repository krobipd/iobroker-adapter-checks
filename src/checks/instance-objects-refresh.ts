import type { Check, Finding } from "../types.js";
import {
  listSourceFiles,
  readJson,
  readText,
  repoPath,
  stripTsComments,
} from "../util.js";

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
 * `common` keys that describe the object's static shape. The manifest owns them: a refresh
 * that repeats them is a second source, and a changed role or type in the manifest is written
 * back to the old value on every start. `states` is not among them — an adapter may fill it
 * from the device (measured: the lgtv fork refreshes its input list that way).
 */
const SHAPE_COMMON_KEYS = new Set([
  "type",
  "role",
  "read",
  "write",
  "def",
  "unit",
  "min",
  "max",
  "step",
]);

/**
 * The object literal that starts at `start`, or undefined when there is none. Braces inside
 * strings and template literals do not count.
 *
 * @param text the source
 * @param start offset of the opening brace
 * @returns the literal including its braces
 */
function objectLiteralAt(text: string, start: number): string | undefined {
  if (text[start] !== "{") {
    return undefined;
  }
  let depth = 0;
  let quote: string | undefined;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote !== undefined) {
      if (c === "\\") {
        i++;
      } else if (c === quote) {
        quote = undefined;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

/**
 * The keys at the top level of an object literal with the offset where each value starts
 * (-1 for a shorthand property). A spread is reported as `...`.
 *
 * @param literal an object literal including its braces
 * @returns the keys in source order
 */
function topLevelEntries(literal: string): { key: string; value: number }[] {
  const entries: { key: string; value: number }[] = [];
  let depth = 0;
  let quote: string | undefined;
  let expectKey = false;
  for (let i = 0; i < literal.length; i++) {
    const c = literal[i] ?? "";
    if (quote !== undefined) {
      if (c === "\\") {
        i++;
      } else if (c === quote) {
        quote = undefined;
      }
      continue;
    }
    if (expectKey && depth === 1 && !/\s/.test(c)) {
      expectKey = false;
      const m = /^(\.\.\.|[A-Za-z_$][\w$]*|"[^"]*"|'[^']*')\s*(:)?/.exec(
        literal.slice(i),
      );
      if (m?.[1] !== undefined) {
        entries.push({
          key: m[1].replace(/^["']|["']$/g, ""),
          value: m[2] === undefined ? -1 : i + m[0].length,
        });
        i += m[1].length - 1;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "{" || c === "[" || c === "(") {
      depth++;
      if (depth === 1) {
        expectKey = true;
      }
    } else if (c === "}" || c === "]" || c === ")") {
      depth--;
    } else if (c === "," && depth === 1) {
      expectKey = true;
    }
  }
  return entries;
}

/**
 * What a refresh literal carries beyond `common.name` / `common.desc` that belongs to the
 * manifest: any top-level key besides `common` (the object type, `native`) and the static
 * shape keys inside `common`. A spread or a non-literal `common` cannot be read and is left
 * alone — the check can only become quieter there, never wrong.
 *
 * @param literal the second argument of the extendObject call
 * @returns the offending keys, `common.`-prefixed where they sit in common
 */
function shapeCopy(literal: string): string[] {
  const extra: string[] = [];
  for (const entry of topLevelEntries(literal)) {
    if (entry.key === "...") {
      continue;
    }
    if (entry.key !== "common") {
      extra.push(entry.key);
      continue;
    }
    const common =
      entry.value >= 0
        ? objectLiteralAt(
            literal,
            literal.slice(entry.value).search(/\S/) + entry.value,
          )
        : undefined;
    for (const inner of common === undefined ? [] : topLevelEntries(common)) {
      if (SHAPE_COMMON_KEYS.has(inner.key)) {
        extra.push(`common.${inner.key}`);
      }
    }
  }
  return extra;
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
    // Since 0.19.0 (tooling round 42, hueemu audit W4): the refresh carries the name and the
    // description only — the fleet rule "the rest of the shape stays in the manifest alone" had
    // no gate, and four adapters copied role/type/read/write/def into it.
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
    // Comments out: a commented-out `extendObject("info.x", …)` counted as the refresh until 0.15.0 (tooling audit
    // 2026-09-24, P2) — the installation never saw it.
    const texts = files.map((file) => ({
      rel: repoPath(adapterDir, file),
      text: stripTsComments(
        readText(adapterDir, repoPath(adapterDir, file)) ?? "",
      ),
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
      let hit:
        { rel: string; text: string; index: number; end: number } | undefined;
      for (const t of texts) {
        const m = call.exec(t.text);
        if (m) {
          hit = {
            rel: t.rel,
            text: t.text,
            index: m.index,
            end: m.index + m[0].length,
          };
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
      const lead = /^\s*,\s*/.exec(hit.text.slice(hit.end));
      const literal = lead
        ? objectLiteralAt(hit.text, hit.end + lead[0].length)
        : undefined;
      const extra = literal === undefined ? [] : shapeCopy(literal);
      if (extra.length > 0) {
        findings.push({
          check: instanceObjectsRefreshCheck.id,
          file: hit.rel,
          line: hit.text.slice(0, hit.index).split("\n").length,
          message: `'${id}' is refreshed with more than its name and description (${extra.join(", ")})`,
          impact:
            "the manifest owns the object's shape — a runtime copy is a second source that drifts (a role or type changed in the manifest is written back on every start); keep common.name and common.desc only",
        });
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
