import type TS from "typescript";
import { typescriptApi } from "../adapter-api.js";
import { parseSources } from "../sources.js";
import type { Check, Finding } from "../types.js";
import { listSourceFiles, repoPath } from "../util.js";
import { errorTextHelpers } from "./error-text-helper.js";

/** The comparison operators a `typeof` test uses. */
const EQUALITY_KINDS = [
  "EqualsEqualsEqualsToken",
  "ExclamationEqualsEqualsToken",
  "EqualsEqualsToken",
  "ExclamationEqualsToken",
] as const;

/** The two things an Error's text needs besides its message, and what is lost without each. */
const PARTS = [
  {
    property: "cause",
    message:
      "never reads `.cause`: an Error's text is its message alone, and Node's `fetch` rejects every network failure as `TypeError: fetch failed` with the reason only in the cause (`getaddrinfo ENOTFOUND host`, `connect ECONNREFUSED 10.0.0.2:80`, `other side closed`) — the log line says `fetch failed` and nothing else",
  },
  {
    property: "code",
    message:
      'never reads `.code`: an Error with an empty message renders as nothing — `http.get` and `net.connect` to `localhost` reject with an `AggregateError` whose message is `""` and whose reason is `code: "ECONNREFUSED"` (for `fetch` that AggregateError is the cause)',
  },
] as const;

const FUNCTION_MESSAGE =
  'never tests `typeof … === "function"`: a thrown function or class falls into the branch for primitives, and `String()` renders its whole source text into the log';

/** What an Error's own properties may hold: a getter that throws, or something that is not a string. */
const GUARDED_PROPERTIES: ReadonlySet<string> = new Set([
  "message",
  "name",
  "code",
  "cause",
]);

const OUTSIDE_TRY_MESSAGE =
  "outside a `try`: it runs inside a `catch`, and a getter that throws or a `message` that is not a string (`text.includes(…)` on a number) makes the catch block throw a second time — the error it was handed never reaches the log, and the new one escapes the handler";

const ADVICE =
  "for an Error the helper returns its message (its string `code` when the message is empty) and, one level deep, the text of its `cause` (an Error's message or code, any other value through the helper's own branches), unless the message already contains it: `fetch failed (getaddrinfo ENOTFOUND host)`; a thrown function or class renders as its type tag (`Object.prototype.toString.call`), and the whole body sits in a `try` whose `catch` returns that tag";

/**
 * The repository's error-text helper renders an Error with its reason: the message, the `code`
 * when the message is empty, and one level of `cause` — and it never throws itself and never
 * prints a function's source.
 *
 * ES2022 gave `Error` a `cause`, and Node's `fetch` (undici, `lib/web/fetch/index.js`) rejects
 * with `new TypeError('fetch failed', { cause: response.error })` — the message is the same for
 * every network failure, the reason is only in the cause. A helper that returns `err.message`
 * turns an unreachable host, a refused port and a dropped socket into the same `fetch failed`.
 * `http.get` and `net.connect` to `localhost` try both address families and reject with an
 * `AggregateError` whose message is empty and whose `code` carries the reason (`fetch` wraps the
 * same AggregateError as its cause); `err.message` alone renders nothing at all. Measured on
 * Node 22.22.2.
 *
 * Judged with the TypeScript compiler of the adapter, on the helper `error-text-helper` names as
 * the repository's (the first function below `src/` that carries the object branch): its body
 * reads a property `cause` (`err.cause`, `const { cause } = err`) and a property `code`. That is
 * a structural proxy — it proves the helper looks at both, not how it words them; the words are
 * the helper's own tests. Without a helper the check is silent (`caught-value-text` reports the
 * renderings that need one); without a loadable `typescript` it reports that instead.
 *
 * The helper runs inside a `catch`. Any property of a caught Error can be a getter that throws
 * (`Object.defineProperty(e, "code", { get() { throw … } })`), and `message` can be set to a
 * number — `text.includes(reason)` then throws `TypeError: text.includes is not a function` and
 * the catch block throws a second time. So the body reads `message`, `name`, `code` and `cause`
 * only inside the protected block of a `try`. A thrown function or class has `typeof` "function",
 * not "object": a helper whose primitive branch is `typeof err !== "object"` hands it to
 * `String()`, which returns the function's source text — so the body tests `"function"` (the
 * master form returns `Object.prototype.toString.call(err)`, `[object Function]`). Both are
 * structural proxies as well; a helper that lists every primitive type by name and never names
 * "function" is reported although it would not print source.
 */
export const errorTextReasonCheck: Check = {
  id: "error-text-reason",
  title:
    "the error-text helper renders an Error with its reason — the `code` when the message is empty, one level of `cause` — and never throws or prints source",
  run(adapterDir: string): Finding[] {
    const ts = typescriptApi();
    const files = listSourceFiles(adapterDir, { admin: true });
    if (files.length === 0) {
      return [];
    }
    if (!ts) {
      // Fail closed: a standard that cannot be judged is a finding, not silence.
      return [
        {
          check: errorTextReasonCheck.id,
          file: repoPath(adapterDir, files[0] as string),
          message:
            "the sources could not be parsed: no `typescript` module can be loaded next to this package",
          impact:
            "the check reads the sources with the adapter's own compiler (a dev dependency of every TypeScript adapter) — until it is installed this standard is not judged",
        },
      ];
    }
    const [helper] = errorTextHelpers(
      ts,
      parseSources(ts, adapterDir, files),
      adapterDir,
    );
    if (!helper) {
      return [];
    }
    const read = readProperties(ts, helper.fn.body);
    const messages: string[] = PARTS.filter(
      (part) => !read.has(part.property),
    ).map((part) => part.message);
    if (!testsForFunction(ts, helper.fn.body)) {
      messages.push(FUNCTION_MESSAGE);
    }
    const unguarded = readsOutsideTry(ts, helper.fn.body);
    if (unguarded.length > 0) {
      messages.push(
        `reads ${unguarded.map((name) => `\`.${name}\``).join(", ")} ${OUTSIDE_TRY_MESSAGE}`,
      );
    }
    return messages.map((message) => ({
      check: errorTextReasonCheck.id,
      file: helper.file,
      line: helper.line,
      message: `the error-text helper ${helper.name} ${message}`,
      impact: ADVICE,
    }));
  },
};

/**
 * Whether a function body tests a value's type against `"function"`: `typeof x === "function"`
 * (also `!==`, `==`, `!=`, either side) or `case "function":` in a `switch (typeof x)`.
 *
 * @param ts the TypeScript compiler API
 * @param body the function body
 * @returns true when the body names the function type
 */
function testsForFunction(ts: typeof TS, body: TS.Node): boolean {
  const equality = new Set<TS.SyntaxKind>(
    EQUALITY_KINDS.map((kind) => ts.SyntaxKind[kind]),
  );
  const isFunctionLiteral = (node: TS.Node): boolean =>
    ts.isStringLiteralLike(node) && node.text === "function";
  let found = false;
  const visit = (node: TS.Node): void => {
    if (found) {
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      equality.has(node.operatorToken.kind) &&
      ((ts.isTypeOfExpression(node.left) && isFunctionLiteral(node.right)) ||
        (ts.isTypeOfExpression(node.right) && isFunctionLiteral(node.left)))
    ) {
      found = true;
      return;
    }
    if (
      ts.isCaseClause(node) &&
      isFunctionLiteral(node.expression) &&
      ts.isTypeOfExpression(node.parent.parent.expression)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/**
 * The properties of a caught value the helper reads outside the protected block of a `try`
 * (`message`, `name`, `code`, `cause` — by access or destructuring), in the order they first
 * appear. A read in a `catch` clause or a `finally` block counts as outside.
 *
 * @param ts the TypeScript compiler API
 * @param body the function body
 * @returns the property names read unprotected
 */
function readsOutsideTry(ts: typeof TS, body: TS.Node): string[] {
  const names: string[] = [];
  const note = (name: string, inTry: boolean): void => {
    if (!inTry && GUARDED_PROPERTIES.has(name) && !names.includes(name)) {
      names.push(name);
    }
  };
  const visit = (node: TS.Node, inTry: boolean): void => {
    if (ts.isTryStatement(node)) {
      visit(node.tryBlock, true);
      if (node.catchClause) {
        visit(node.catchClause, inTry);
      }
      if (node.finallyBlock) {
        visit(node.finallyBlock, inTry);
      }
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      note(node.name.text, inTry);
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent)
    ) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key)) {
        note(key.text, inTry);
      }
    }
    ts.forEachChild(node, (child) => visit(child, inTry));
  };
  visit(body, false);
  return names;
}

/**
 * The property names a function body reads: `x.name`, `x?.name` and destructured `{ name }` /
 * `{ name: alias }`.
 *
 * @param ts the TypeScript compiler API
 * @param body the function body
 * @returns the names
 */
function readProperties(ts: typeof TS, body: TS.Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: TS.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      names.add(node.name.text);
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent)
    ) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key)) {
        names.add(key.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return names;
}
