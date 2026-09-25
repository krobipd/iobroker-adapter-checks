import type TS from "typescript";
import { adapterCalls, typescriptApi } from "../adapter-api.js";
import type { Check, Finding } from "../types.js";
import { listSourceFiles, readJson, readText, repoPath } from "../util.js";

/** Object writes that can put a `native` value into the instance object as written. */
const WRITES = new Set([
  "extendForeignObject",
  "extendForeignObjectAsync",
  "setForeignObject",
  "setForeignObjectAsync",
]);

/**
 * The value expression when it is a call to `encrypt` (`this.encrypt(x)`, `adapter.encrypt(x)`,
 * `encrypt(x)`), unwrapped from `await` and parentheses.
 *
 * @param ts the TypeScript compiler API
 * @param node the value expression
 * @returns true for an encrypt call
 */
function isEncryptCall(ts: typeof TS, node: TS.Expression): boolean {
  let expr: TS.Expression = node;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAwaitExpression(expr) ||
    ts.isAsExpression(expr)
  ) {
    expr = expr.expression;
  }
  if (!ts.isCallExpression(expr)) {
    return false;
  }
  const callee = expr.expression;
  const name = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isIdentifier(callee)
      ? callee.text
      : "";
  return name === "encrypt";
}

/**
 * A value that clears the setting rather than storing a secret: `null`, `undefined` or `""`.
 *
 * @param ts the TypeScript compiler API
 * @param node the value expression
 * @returns true for a clearing value
 */
function isClearing(ts: typeof TS, node: TS.Expression): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined") ||
    ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === "")
  );
}

/**
 * The values a local object receives for secret keys before it is written as `native`: its
 * initializer literal and every `name.key = value` / `name["key"] = value` in the same function.
 * hueemu (2026-09-25) built `generated.tlsKey = material.key` and wrote `{ native: generated }`.
 *
 * @param ts the TypeScript compiler API
 * @param call the write call
 * @param name the identifier passed as `native`
 * @returns key and value expression pairs
 */
function localAssignments(
  ts: typeof TS,
  call: TS.CallExpression,
  name: string,
): Array<[string, TS.Expression | undefined]> {
  let scope: TS.Node | undefined = call.parent;
  while (scope && !ts.isFunctionLike(scope)) {
    scope = scope.parent;
  }
  const out: Array<[string, TS.Expression | undefined]> = [];
  const visit = (node: TS.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      if (ts.isObjectLiteralExpression(node.initializer)) {
        out.push(...literalValues(ts, node.initializer));
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = node.left;
      if (
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === name
      ) {
        out.push([left.name.text, node.right]);
      } else if (
        ts.isElementAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === name &&
        ts.isStringLiteral(left.argumentExpression)
      ) {
        out.push([left.argumentExpression.text, node.right]);
      }
    }
    ts.forEachChild(node, visit);
  };
  if (scope) {
    visit(scope);
  }
  return out;
}

/**
 * Key and value of every property of an object literal; a shorthand has no value expression.
 *
 * @param ts the TypeScript compiler API
 * @param literal the object literal
 * @returns key and value expression pairs
 */
function literalValues(
  ts: typeof TS,
  literal: TS.ObjectLiteralExpression,
): Array<[string, TS.Expression | undefined]> {
  const out: Array<[string, TS.Expression | undefined]> = [];
  for (const prop of literal.properties) {
    if (ts.isPropertyAssignment(prop)) {
      out.push([
        prop.name.getText().replace(/^["']|["']$/g, ""),
        prop.initializer,
      ]);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      out.push([prop.name.text, undefined]);
    }
  }
  return out;
}

/**
 * The `native` value of a write's object argument: a literal, or the identifier of a local object.
 *
 * @param ts the TypeScript compiler API
 * @param arg the object argument of the write
 * @returns the value expression, or undefined when `native` is absent
 */
function nativeValue(
  ts: typeof TS,
  arg: TS.Expression | undefined,
): TS.Expression | undefined {
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    return undefined;
  }
  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name.getText() === "native") {
      return prop.initializer;
    }
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "native") {
      return prop.name;
    }
  }
  return undefined;
}

/**
 * A value an adapter writes into an `encryptedNative` setting of its own instance object goes
 * through `encrypt()` first.
 *
 * js-controller encrypts `encryptedNative` fields only on the admin's save and in
 * `updateConfig()` (7.2.2 `adapter.ts` `updateConfig`), and decrypts every such field on each
 * start (`adapter.ts` ~11671-11690). A value written with `extendForeignObject(Async)` or
 * `setForeignObject(Async)` lands in clear text; the next start runs it through `decrypt`,
 * which turns a value without the `$/aes-192-cbc:` prefix into garbage (`decryptLegacy`).
 * Measured on hueemu (audit 2026-09-25, since v1.4.7): the generated TLS key was stored in
 * clear text, every start decrypted it to garbage, generated a new certificate, persisted it
 * and restarted — the bridge never served, over HTTPS or HTTP.
 *
 * Judged: every write to an id containing `system.adapter.` whose `native` is an object literal
 * or a local object (its initializer and every `name.key = value` in the same function); each
 * key listed in the root `encryptedNative` of io-package.json must be given as `encrypt(…)` or a
 * clearing value (`null`, `undefined`, `""`). A shorthand names a variable nobody encrypted here
 * and is reported — write `key: this.encrypt(key)`. `updateConfig()` encrypts on its own and is
 * not judged; neither is a `native` from anywhere else (a parameter, a helper's return value).
 */
export const encryptedNativeWriteCheck: Check = {
  id: "encrypted-native-write",
  title:
    "a value written into an encryptedNative setting goes through encrypt()",
  run(adapterDir: string): Finding[] {
    const iopkg = readJson<{ encryptedNative?: unknown }>(
      adapterDir,
      "io-package.json",
    );
    const secret = Array.isArray(iopkg?.encryptedNative)
      ? new Set(
          iopkg.encryptedNative.filter(
            (k): k is string => typeof k === "string",
          ),
        )
      : new Set<string>();
    if (secret.size === 0) {
      return [];
    }
    const findings: Finding[] = [];
    for (const file of listSourceFiles(adapterDir)) {
      const rel = repoPath(adapterDir, file);
      const calls = adapterCalls(readText(adapterDir, rel) ?? "", rel);
      const ts = typescriptApi();
      if (!calls || !ts) {
        return [
          {
            check: encryptedNativeWriteCheck.id,
            file: rel,
            message:
              "the sources could not be parsed: no `typescript` module can be loaded next to this package",
            impact:
              "the check reads the sources with the adapter's own compiler (a dev dependency of every TypeScript adapter) — until it is installed this standard is not judged",
          },
        ];
      }
      for (const call of calls) {
        if (
          !WRITES.has(call.name) ||
          !(call.args[0] ?? "").includes("system.adapter.")
        ) {
          continue;
        }
        const native = nativeValue(ts, call.node.arguments[1]);
        const pairs = !native
          ? []
          : ts.isObjectLiteralExpression(native)
            ? literalValues(ts, native)
            : ts.isIdentifier(native)
              ? localAssignments(ts, call.node, native.text)
              : [];
        for (const [key, value] of pairs) {
          if (
            !secret.has(key) ||
            (value && (isEncryptCall(ts, value) || isClearing(ts, value)))
          ) {
            continue;
          }
          findings.push({
            check: encryptedNativeWriteCheck.id,
            file: rel,
            line: call.line,
            message: `${call.name} writes native.${key} (listed in encryptedNative) without encrypt()`,
            impact: `js-controller encrypts these settings only on the admin's save and in updateConfig(); written like this the value is stored in clear text, and the next start decrypts it to garbage — write \`${key}: this.encrypt(value)\` or use updateConfig()`,
          });
        }
      }
    }
    return findings;
  },
};
