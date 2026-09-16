import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adapterCalls } from "../adapter-api.js";
import type { Check, Finding } from "../types.js";
import { listSourceFiles, readJson, readText, repoPath } from "../util.js";

/**
 * A JSDoc block holding `@deprecated`, followed by a method signature: the name, an optional type
 * parameter list, the opening parenthesis. Property declarations (`foo?: string`) do not match —
 * a call can only hit a method. The tag's text ends at the line end or at the comment end,
 * whichever comes first (the file also closes a block on the tag's own line); nothing in the
 * pattern may cross a comment end, or the tag of one block would be pinned to the method of
 * the next.
 */
const DEPRECATED_METHOD =
  /\/\*\*(?:(?!\*\/)[\s\S])*?@deprecated((?:(?!\*\/)[^\n])*)(?:(?!\*\/)[\s\S])*?\*\/\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^(]*?>)?\s*\(/g;

/**
 * The deprecated adapter methods of the INSTALLED `@iobroker/types`, read from its declaration
 * files. The list is derived, never copied: it follows the version the adapter resolves.
 *
 * @param adapterDir the adapter repository root
 * @returns method name → advice, plus the package version; undefined when the package is not installed
 */
function installedDeprecations(
  adapterDir: string,
): { version: string; methods: Map<string, string> } | undefined {
  const root = join(adapterDir, "node_modules", "@iobroker", "types");
  const build = join(root, "build");
  if (!existsSync(build)) {
    return undefined;
  }
  const version =
    readJson<{ version?: string }>(
      adapterDir,
      "node_modules/@iobroker/types/package.json",
    )?.version ?? "unknown";
  const methods = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      if (name.endsWith(".d.ts")) {
        let text: string;
        try {
          text = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        for (const m of text.matchAll(DEPRECATED_METHOD)) {
          const [, tag, method] = m as unknown as [string, string, string];
          const advice = tag.trim();
          if (!methods.has(method)) {
            methods.set(method, advice);
          }
        }
      } else if (!name.includes(".")) {
        walk(full);
      }
    }
  };
  walk(build);
  return { version, methods };
}

/**
 * The adapter calls no method that its installed `@iobroker/types` marks `@deprecated`.
 *
 * The list is read from the declaration files below `node_modules/@iobroker/types/build/`, so it
 * is exactly what the adapter's own type check would show as strike-through — and it moves with
 * the version the adapter resolves (7.2.2: `setStateAsync`, `extendObjectAsync`,
 * `setObjectAsync`, `setForeignObjectAsync`, `createState`, `deleteState` and their relatives).
 * A copied list would have drifted: a fleet memory that named "the two" deprecated methods in
 * 2026-07 was wrong for 7.2.2 by the autumn.
 *
 * Judged are calls on the adapter itself — `this` inside a class that extends `…Adapter`,
 * `adapter`, `….adapter` — so a library class with its own `createState` method is not
 * reported. An adapter without `@iobroker/types` in `node_modules` has nothing to derive from
 * and gets no finding.
 */
export const deprecatedAdapterMethodsCheck: Check = {
  id: "deprecated-adapter-methods",
  title: "no call to a method the installed @iobroker/types marks deprecated",
  run(adapterDir: string): Finding[] {
    const findings: Finding[] = [];
    const deprecated = installedDeprecations(adapterDir);
    if (!deprecated || deprecated.methods.size === 0) {
      return findings;
    }
    for (const file of listSourceFiles(adapterDir)) {
      const rel = repoPath(adapterDir, file);
      const calls = adapterCalls(readText(adapterDir, rel) ?? "", rel);
      if (!calls) {
        return findings;
      }
      for (const call of calls) {
        const advice = call.onAdapter
          ? deprecated.methods.get(call.name)
          : undefined;
        if (advice === undefined) {
          continue;
        }
        findings.push({
          check: deprecatedAdapterMethodsCheck.id,
          file: rel,
          line: call.line,
          message: `${call.receiver}.${call.name}() is deprecated in @iobroker/types ${deprecated.version}: ${advice}`,
          impact:
            "a deprecated method is the next removal — the adapter's own type check already shows it struck through",
        });
      }
    }
    return findings;
  },
};
