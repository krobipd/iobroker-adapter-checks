import type TS from "typescript";
import { typescriptApi } from "../adapter-api.js";
import { functionWithBody, parseSources } from "../sources.js";
import type { Check, Finding } from "../types.js";
import { listSourceFiles, readText, repoPath } from "../util.js";

/** The dm-utils base class of a device manager. */
const DEVICE_MANAGEMENT = "DeviceManagement";

/**
 * The innermost function with a body around a node.
 *
 * @param ts the TypeScript compiler API
 * @param node any node
 * @returns the function, or undefined at module or class-field level
 */
function enclosingFunction(
  ts: typeof TS,
  node: TS.Node,
): (TS.FunctionLikeDeclaration & { body: TS.ConciseBody }) | undefined {
  let n: TS.Node | undefined = node.parent;
  while (n) {
    const fn = functionWithBody(ts, n);
    if (fn) {
      return fn;
    }
    n = n.parent;
  }
  return undefined;
}

/**
 * Whether a call is `I18n.init(…)` — also `utils.I18n.init(…)`.
 *
 * @param ts the TypeScript compiler API
 * @param node any node
 * @returns true for the call
 */
function isI18nInit(ts: typeof TS, node: TS.Node): node is TS.CallExpression {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const e = node.expression;
  if (!ts.isPropertyAccessExpression(e) || e.name.text !== "init") {
    return false;
  }
  const holder = e.expression;
  return (
    (ts.isIdentifier(holder) && holder.text === "I18n") ||
    (ts.isPropertyAccessExpression(holder) && holder.name.text === "I18n")
  );
}

/**
 * The call a statement runs, past `await`, parentheses and a trailing `.catch(…)` / `.then(…)`.
 *
 * @param ts the TypeScript compiler API
 * @param statement a statement
 * @returns the innermost call, or undefined when the statement is not an expression statement
 */
function statementCall(
  ts: typeof TS,
  statement: TS.Statement | undefined,
): TS.Node | undefined {
  if (!statement || !ts.isExpressionStatement(statement)) {
    return undefined;
  }
  let e: TS.Expression = statement.expression;
  for (;;) {
    if (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) {
      e = e.expression;
    } else if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      ["catch", "then"].includes(e.expression.name.text) &&
      ts.isCallExpression(e.expression.expression)
    ) {
      e = e.expression.expression;
    } else {
      return e;
    }
  }
}

/**
 * The first statement a function runs — the first statement of a leading `try` block counts as the first.
 *
 * @param ts the TypeScript compiler API
 * @param fn a function with a body
 * @returns the statement, or undefined for an expression body or an empty block
 */
function firstStatement(
  ts: typeof TS,
  fn: TS.FunctionLikeDeclaration & { body: TS.ConciseBody },
): TS.Statement | undefined {
  if (!ts.isBlock(fn.body)) {
    return undefined;
  }
  const first = fn.body.statements[0];
  if (first && ts.isTryStatement(first)) {
    return first.tryBlock.statements[0];
  }
  return first;
}

/**
 * A readable name of a function for a message.
 *
 * @param ts the TypeScript compiler API
 * @param fn the function
 * @returns the name, or "its function"
 */
function functionName(ts: typeof TS, fn: TS.FunctionLikeDeclaration): string {
  if (fn.name && ts.isIdentifier(fn.name)) {
    return fn.name.text;
  }
  const holder = fn.parent;
  if (
    holder &&
    (ts.isVariableDeclaration(holder) ||
      ts.isPropertyDeclaration(holder) ||
      ts.isPropertyAssignment(holder)) &&
    ts.isIdentifier(holder.name)
  ) {
    return holder.name.text;
  }
  return "its function";
}

/**
 * The names of every class that is a device manager: `DeviceManagement` itself and each class in the sources that
 * extends it, directly or through another one.
 *
 * @param ts the TypeScript compiler API
 * @param trees the parsed sources
 * @returns the class names
 */
function deviceManagerClasses(
  ts: typeof TS,
  trees: Iterable<TS.SourceFile>,
): Set<string> {
  const parents = new Map<string, string>();
  const visit = (node: TS.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
          continue;
        }
        for (const type of clause.types) {
          const base = type.expression;
          const name = ts.isIdentifier(base)
            ? base.text
            : ts.isPropertyAccessExpression(base)
              ? base.name.text
              : undefined;
          if (name) {
            parents.set(node.name.text, name);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const tree of trees) {
    visit(tree);
  }
  const managers = new Set<string>([DEVICE_MANAGEMENT]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, parent] of parents) {
      if (managers.has(parent) && !managers.has(child)) {
        managers.add(child);
        grew = true;
      }
    }
  }
  return managers;
}

/**
 * Messages reach the adapter only after `I18n.init` has run — shelly's order.
 *
 * js-controller 7.2.2 subscribes the messagebox in `_prepareInitAdapter` and emits every `message` without asking
 * `adapterReady` (`packages/adapter/src/lib/adapter/adapter.ts`), so messages arrive before `onReady` and while it
 * runs. dm-utils 3.2.1 registers its `message` listener in the `DeviceManagement` constructor, and adapter-core 3.4.3
 * `I18n.translate` / `getTranslatedObject` throw "i18n not initialized" before `init`. A device-manager message in
 * that window — the admin reloads the device list while the instance restarts after a save — answers nothing.
 *
 * The form, as in `ioBroker.shelly` (`src/main.ts`): `await I18n.init(…)` is the first statement of its function (the
 * first statement of a leading `try` counts); a device manager (a class extending `DeviceManagement`) is constructed
 * only in a function that ran `I18n.init` before it; no `message` handler is registered in a constructor — neither
 * `this.on("message", …)` nor a `message` option to `super(…)`. Judged only in an adapter that uses `I18n`.
 */
export const i18nBeforeMessagesCheck: Check = {
  id: "i18n-before-messages",
  title:
    "I18n.init runs first in onReady, and the device manager and message handlers come after it",
  run(adapterDir: string): Finding[] {
    const files = listSourceFiles(adapterDir);
    if (
      !files.some((file) =>
        /\bI18n\b/.test(readText(adapterDir, repoPath(adapterDir, file)) ?? ""),
      )
    ) {
      return [];
    }
    const ts = typescriptApi();
    if (!ts) {
      return [
        {
          check: i18nBeforeMessagesCheck.id,
          file: "src",
          message:
            "the sources could not be parsed: no `typescript` module can be loaded next to this package",
          impact:
            "the check reads the sources with the adapter's own compiler (a dev dependency of every TypeScript adapter) — until it is installed this standard is not judged",
        },
      ];
    }
    const trees = parseSources(ts, adapterDir, files);
    const managers = deviceManagerClasses(ts, trees.values());
    const findings: Finding[] = [];
    const impact =
      "js-controller delivers messages before onReady has finished; a handler that translates before I18n.init throws and the admin gets no answer";

    for (const [file, tree] of trees) {
      const rel = repoPath(adapterDir, file);
      const lineOf = (node: TS.Node): number =>
        tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
      const inits: TS.CallExpression[] = [];
      const visit = (node: TS.Node): void => {
        if (isI18nInit(ts, node)) {
          inits.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);

      for (const init of inits) {
        const fn = enclosingFunction(ts, init);
        if (!fn || statementCall(ts, firstStatement(ts, fn)) !== init) {
          findings.push({
            check: i18nBeforeMessagesCheck.id,
            file: rel,
            line: lineOf(init),
            message: `I18n.init is not the first statement of ${fn ? functionName(ts, fn) : "a function"}`,
            impact,
          });
        }
      }

      const judge = (node: TS.Node): void => {
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          managers.has(node.expression.text)
        ) {
          const fn = enclosingFunction(ts, node);
          const after =
            fn !== undefined &&
            inits.some(
              (init) =>
                enclosingFunction(ts, init) === fn && init.end <= node.pos,
            );
          if (!after) {
            findings.push({
              check: i18nBeforeMessagesCheck.id,
              file: rel,
              line: lineOf(node),
              message: `the device manager ${node.expression.text} is constructed before I18n.init has run`,
              impact:
                "dm-utils listens for messages from its constructor on — construct it in onReady after `await I18n.init(…)`",
            });
          }
        }
        if (ts.isConstructorDeclaration(node) && node.body) {
          const inCtor = (n: TS.Node): void => {
            if (functionWithBody(ts, n) && n !== node) {
              return; // a callback defined here runs later, not in the constructor
            }
            if (ts.isCallExpression(n)) {
              const e = n.expression;
              const first = n.arguments[0];
              if (
                ts.isPropertyAccessExpression(e) &&
                e.expression.kind === ts.SyntaxKind.ThisKeyword &&
                ["on", "addListener", "once"].includes(e.name.text) &&
                first &&
                ts.isStringLiteralLike(first) &&
                first.text === "message"
              ) {
                findings.push({
                  check: i18nBeforeMessagesCheck.id,
                  file: rel,
                  line: lineOf(n),
                  message:
                    "the constructor registers a message handler before I18n.init has run",
                  impact,
                });
              }
              if (e.kind === ts.SyntaxKind.SuperKeyword) {
                for (const arg of n.arguments) {
                  if (!ts.isObjectLiteralExpression(arg)) {
                    continue;
                  }
                  for (const prop of arg.properties) {
                    if (
                      prop.name &&
                      (ts.isIdentifier(prop.name) ||
                        ts.isStringLiteral(prop.name)) &&
                      prop.name.text === "message"
                    ) {
                      findings.push({
                        check: i18nBeforeMessagesCheck.id,
                        file: rel,
                        line: lineOf(prop),
                        message:
                          "the constructor passes a message handler to super() before I18n.init has run",
                        impact,
                      });
                    }
                  }
                }
              }
            }
            ts.forEachChild(n, inCtor);
          };
          ts.forEachChild(node.body, inCtor);
        }
        ts.forEachChild(node, judge);
      };
      judge(tree);
    }
    return findings;
  },
};
