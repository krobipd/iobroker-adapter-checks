import type TS from "typescript";
import { typescriptApi } from "../adapter-api.js";
import { functionWithBody, parseSources } from "../sources.js";
import type { Check, Finding } from "../types.js";
import { listSourceFiles, readText, repoPath } from "../util.js";

/** The fleet helper whose result decides whether the start goes on. */
const MIGRATION = "migrateNativeKeys";

/** How many wrappers deep a forwarded result is followed. */
const MAX_FORWARDS = 5;

/**
 * The expression a value lands in, past the wrappers that do not consume it (`await`, parentheses, `as`, `!`).
 *
 * @param ts the TypeScript compiler API
 * @param node the call
 * @returns the outermost wrapper and its parent
 */
function landing(
  ts: typeof TS,
  node: TS.Node,
): { outer: TS.Node; parent: TS.Node } {
  let outer = node;
  while (
    ts.isAwaitExpression(outer.parent) ||
    ts.isParenthesizedExpression(outer.parent) ||
    ts.isAsExpression(outer.parent) ||
    ts.isNonNullExpression(outer.parent) ||
    ts.isSatisfiesExpression(outer.parent)
  ) {
    outer = outer.parent;
  }
  return { outer, parent: outer.parent };
}

/**
 * The name callers use for the function whose result this expression is: a function declaration, a method, or an
 * arrow/function expression assigned to a variable or property. Undefined for an anonymous callback — its result goes
 * wherever the caller puts it, which this check does not follow.
 *
 * @param ts the TypeScript compiler API
 * @param node a node inside the function
 * @returns the name, or undefined
 */
function enclosingName(ts: typeof TS, node: TS.Node): string | undefined {
  let n: TS.Node | undefined = node.parent;
  while (n && !functionWithBody(ts, n)) {
    n = n.parent;
  }
  if (!n) {
    return undefined;
  }
  if (
    (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
    n.name &&
    ts.isIdentifier(n.name)
  ) {
    return n.name.text;
  }
  const holder = n.parent;
  if (
    holder &&
    (ts.isVariableDeclaration(holder) ||
      ts.isPropertyDeclaration(holder) ||
      ts.isPropertyAssignment(holder))
  ) {
    return ts.isIdentifier(holder.name) ? holder.name.text : undefined;
  }
  return undefined;
}

/**
 * The name a call invokes: `name(…)` or `<anything>.name(…)`.
 *
 * @param ts the TypeScript compiler API
 * @param call the call
 * @returns the name, or undefined for a computed callee
 */
function calleeName(
  ts: typeof TS,
  call: TS.CallExpression,
): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) {
    return e.text;
  }
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
    return e.name.text;
  }
  return undefined;
}

/**
 * The result of `migrateNativeKeys` decides whether the start goes on — it is never dropped.
 *
 * The fleet master (`native-key-migration.ts`) returns `true` when it wrote the instance object. js-controller 7.2.2
 * restarts an instance on EVERY change of its instance object (`controller/src/main.ts`, the objects `change` handler:
 * `stopInstance` and a restart for any `system.adapter.<name>.<n>` change of a running instance), so a start that goes
 * on after that write binds ports, opens connections and writes states in a process that is about to be stopped — the
 * master's contract is "the caller aborts its start when this reports a write". Found in yamaha 3.0.1 (audit
 * 2026-09-29, A36): `await migrateNativeKeys(…);` as a statement of its own.
 *
 * Judged with the adapter's own TypeScript compiler: a call to `migrateNativeKeys`, awaited or not, standing as an
 * expression statement or under `void` is a finding. A wrapper that returns the result (`return migrateNativeKeys(…)`,
 * an arrow body) passes the duty to its callers, followed by name up to five wrappers deep: a call of the wrapper is
 * judged the same way. Any other use — a condition, a variable, an argument — counts as used; what the code then does
 * with it is not judged. Without a loadable `typescript` the check reports that instead of staying silent.
 */
export const migrationResultUsedCheck: Check = {
  id: "migration-result-used",
  title:
    "the result of migrateNativeKeys decides whether the start goes on — it is never dropped",
  run(adapterDir: string): Finding[] {
    const files = listSourceFiles(adapterDir);
    if (
      !files.some((file) =>
        (readText(adapterDir, repoPath(adapterDir, file)) ?? "").includes(
          MIGRATION,
        ),
      )
    ) {
      return [];
    }
    const ts = typescriptApi();
    if (!ts) {
      return [
        {
          check: migrationResultUsedCheck.id,
          file: "src",
          message:
            "the sources could not be parsed: no `typescript` module can be loaded next to this package",
          impact:
            "the check reads the sources with the adapter's own compiler (a dev dependency of every TypeScript adapter) — until it is installed this standard is not judged",
        },
      ];
    }
    const trees = parseSources(ts, adapterDir, files);
    const findings: Finding[] = [];
    const watched = new Map<string, string>([[MIGRATION, MIGRATION]]); // name → what it forwards, for the message
    const judged = new Set<string>();
    for (let round = 0; round <= MAX_FORWARDS; round++) {
      const added: [string, string][] = [];
      for (const [file, sf] of trees) {
        const visit = (node: TS.Node): void => {
          if (ts.isCallExpression(node)) {
            const name = calleeName(ts, node);
            const key = `${file}:${node.getStart(sf)}`;
            if (name && watched.has(name) && !judged.has(key)) {
              judged.add(key);
              const { outer, parent } = landing(ts, node);
              const line =
                sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
              if (
                ts.isExpressionStatement(parent) ||
                ts.isVoidExpression(parent)
              ) {
                const via = watched.get(name);
                findings.push({
                  check: migrationResultUsedCheck.id,
                  file: repoPath(adapterDir, file),
                  line,
                  message:
                    via === name
                      ? `the result of ${name} is dropped — the start goes on after the instance object was written`
                      : `the result of ${name} (which returns the result of ${via}) is dropped — the start goes on after the instance object was written`,
                  impact:
                    "js-controller restarts the instance on every change of its instance object; a start that goes on binds ports, opens connections and writes states in a process that is about to be stopped — abort the start when it reports a write",
                });
              } else if (
                ts.isReturnStatement(parent) ||
                (ts.isArrowFunction(parent) && parent.body === outer)
              ) {
                const wrapper = enclosingName(ts, outer);
                if (wrapper && !watched.has(wrapper)) {
                  added.push([wrapper, watched.get(name) ?? name]);
                }
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
      if (added.length === 0) {
        break;
      }
      for (const [wrapper, via] of added) {
        watched.set(wrapper, via);
      }
    }
    return findings.sort(
      (a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0),
    );
  },
};
