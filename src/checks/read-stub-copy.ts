import type TS from "typescript";
import { typescriptApi } from "../adapter-api.js";
import { FunctionResolver, parseSources } from "../sources.js";
import type { Check, Finding } from "../types.js";
import { listTestFiles, repoPath } from "../util.js";

/**
 * The adapter methods that read an object, a state or an enum — each with its `Async` twin.
 * The controller answers every one of them with a fresh copy (the value is deserialised from
 * the database on each read), so a stub that hands out what it holds changes the contract.
 */
const READS = new Set(
  [
    "getObject",
    "getForeignObject",
    "getForeignObjects",
    "getAdapterObjects",
    "getObjectView",
    "getObjectList",
    "getEnum",
    "getEnums",
    "getState",
    "getForeignState",
    "getStates",
    "getForeignStates",
  ].flatMap((name) => [name, `${name}Async`]),
);

/** Jest/vitest mock methods that take the implementation of the stub. */
const MOCK_IMPLEMENTATION = new Set([
  "mockImplementation",
  "mockImplementationOnce",
]);
/** Jest/vitest mock methods that take the value the stub answers with. */
const MOCK_VALUE = new Set([
  "mockResolvedValue",
  "mockResolvedValueOnce",
  "mockReturnValue",
  "mockReturnValueOnce",
]);
/** Factories that wrap the implementation of a stub: `vi.fn(impl)`, `jest.fn(impl)`. */
const FN_FACTORIES = new Set(["fn"]);

/**
 * Members that mark a fake as an adapter surface. A callback-form name alone (`getStates`,
 * `getObject`) is also the API of other libraries a test fakes (`date-holidays` has
 * `getStates(country)`); such a name is judged only next to one of these, or on a receiver
 * called `adapter`/`this`. The `…Async` twins are ioBroker's own naming and always count.
 */
const ADAPTER_MARKERS = new Set([
  ...READS,
  "namespace",
  "log",
  "config",
  "setState",
  "setStateAsync",
  "setStateChanged",
  "setStateChangedAsync",
  "setForeignState",
  "setForeignStateAsync",
  "setObject",
  "setObjectAsync",
  "setObjectNotExists",
  "setObjectNotExistsAsync",
  "setForeignObject",
  "setForeignObjectAsync",
  "setForeignObjectNotExists",
  "setForeignObjectNotExistsAsync",
  "extendObject",
  "extendObjectAsync",
  "extendForeignObject",
  "extendForeignObjectAsync",
  "delObject",
  "delObjectAsync",
  "delForeignObject",
  "delForeignObjectAsync",
  "delState",
  "delStateAsync",
  "subscribeStates",
  "subscribeStatesAsync",
  "subscribeForeignStates",
  "subscribeForeignStatesAsync",
  "subscribeObjects",
  "subscribeObjectsAsync",
  "sendTo",
  "setTimeout",
  "clearTimeout",
]);

/** One stub of a read method: where it is bound and what it answers with. */
interface Stub {
  /** The read method's name, e.g. `getObjectAsync`. */
  name: string;
  /** The node the finding points at when nothing more precise is found. */
  at: TS.Node;
  /** The implementation, when the binding carries a function. */
  fn?: TS.FunctionLikeDeclaration & { body: TS.ConciseBody };
  /** Fixed answers (`mockResolvedValue(x)`), when the binding carries values. */
  values: TS.Expression[];
}

/**
 * The name a property-like node is bound under, when it is a plain identifier or string.
 *
 * @param ts the TypeScript compiler API
 * @param name the property name node
 * @returns the text, or undefined for computed names
 */
function propertyName(
  ts: typeof TS,
  name: TS.PropertyName,
): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/**
 * Strips the wrappers a test puts around a value without changing what it is: parentheses,
 * `as`/`satisfies`/`!` casts.
 *
 * @param ts the TypeScript compiler API
 * @param expr the expression
 * @returns the expression inside
 */
function bare(ts: typeof TS, expr: TS.Expression): TS.Expression {
  for (;;) {
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isNonNullExpression(expr) ||
      ts.isTypeAssertionExpression(expr)
    ) {
      expr = expr.expression;
    } else {
      return expr;
    }
  }
}

/**
 * Reads the stubs of read methods in one parsed test file.
 */
class StubReader {
  /**
   * @param ts the TypeScript compiler API
   * @param file the path the parsed sources are keyed by (as listed, not as the compiler
   * normalises it — on Windows `source.fileName` carries forward slashes and misses the map)
   * @param source the parsed test file
   * @param resolver resolves identifiers and `this.method` to the functions they name
   */
  constructor(
    private readonly ts: typeof TS,
    private readonly file: string,
    private readonly source: TS.SourceFile,
    private readonly resolver: FunctionResolver,
  ) {}

  /**
   * Every stub of a read method in the file.
   *
   * @returns the stubs, in source order
   */
  stubs(): Stub[] {
    const ts = this.ts;
    const out: Stub[] = [];
    const visit = (node: TS.Node): void => {
      // `getObjectAsync: impl` / `getObjectAsync = impl` in an object literal or a class.
      if (
        (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
        node.initializer
      ) {
        const name = propertyName(ts, node.name);
        if (name && READS.has(name) && this.adapterMember(name, node)) {
          out.push(this.stubFromValue(name, node.name, node.initializer));
        }
      }
      // `getObjectAsync(id) { … }` in an object literal or a class.
      if (ts.isMethodDeclaration(node) && node.body) {
        const name = propertyName(ts, node.name);
        if (name && READS.has(name) && this.adapterMember(name, node)) {
          out.push({
            name,
            at: node.name,
            fn: node as TS.MethodDeclaration & { body: TS.Block },
            values: [],
          });
        }
      }
      // `adapter.getObjectAsync = impl` / `adapter["getObjectAsync"] = impl`.
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const left = bare(ts, node.left);
        const name = this.memberName(left);
        if (name && READS.has(name) && this.adapterReceiver(name, left)) {
          out.push(this.stubFromValue(name, node.left, node.right));
        }
      }
      // `vi.spyOn(adapter, "getObjectAsync").mockResolvedValue(x)` and
      // `adapter.getObjectAsync.mockImplementation(impl)` — the mock methods on a member.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (MOCK_IMPLEMENTATION.has(node.expression.name.text) ||
          MOCK_VALUE.has(node.expression.name.text)) &&
        node.arguments.length > 0
      ) {
        const name = this.mockedMember(node.expression.expression);
        if (
          name &&
          READS.has(name) &&
          this.adapterReceiver(name, node.expression.expression)
        ) {
          const arg = node.arguments[0] as TS.Expression;
          out.push(
            MOCK_IMPLEMENTATION.has(node.expression.name.text)
              ? this.stubFromValue(name, node.expression.name, arg)
              : { name, at: node.expression.name, values: [arg] },
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(this.source);
    return out;
  }

  /**
   * Whether a member of an object literal or class is an adapter read: an `…Async` name by
   * itself, a callback-form name only next to another adapter member.
   *
   * @param name the member's name
   * @param member the member node
   * @returns true when the member is judged
   */
  private adapterMember(name: string, member: TS.Node): boolean {
    const ts = this.ts;
    if (name.endsWith("Async")) {
      return true;
    }
    const container = member.parent;
    const members: TS.NodeArray<TS.Node> | undefined =
      ts.isObjectLiteralExpression(container)
        ? container.properties
        : ts.isClassLike(container)
          ? container.members
          : undefined;
    return (members ?? []).some((m) => {
      if (m === member) {
        return false;
      }
      const n =
        ts.isPropertyAssignment(m) ||
        ts.isShorthandPropertyAssignment(m) ||
        ts.isMethodDeclaration(m) ||
        ts.isPropertyDeclaration(m)
          ? propertyName(ts, m.name)
          : undefined;
      return n !== undefined && ADAPTER_MARKERS.has(n);
    });
  }

  /**
   * Whether a member bound on a receiver (`x.getObject = …`, `spyOn(x, "getObject")`) is an
   * adapter read: an `…Async` name by itself, a callback-form name only on a receiver called
   * `adapter`, `this` or `…adapter`.
   *
   * @param name the member's name
   * @param target the member access or the mock chain's receiver
   * @returns true when the member is judged
   */
  private adapterReceiver(name: string, target: TS.Expression): boolean {
    const ts = this.ts;
    if (name.endsWith("Async")) {
      return true;
    }
    let cur = bare(ts, target);
    let receiver: TS.Expression | undefined;
    while (ts.isCallExpression(cur)) {
      const callee = cur.expression;
      const spied = cur.arguments[0];
      if (
        ((ts.isIdentifier(callee) && callee.text === "spyOn") ||
          (ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "spyOn")) &&
        spied
      ) {
        // `spyOn(x, "getObject")`: x itself is the receiver.
        receiver = bare(ts, spied);
        break;
      }
      if (!ts.isPropertyAccessExpression(callee)) {
        return false;
      }
      cur = bare(ts, callee.expression);
    }
    receiver ??=
      ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)
        ? bare(ts, cur.expression)
        : cur;
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
      return true;
    }
    const text = receiver.getText(this.source).toLowerCase();
    return text.endsWith("adapter");
  }

  /**
   * The member a binding target names: `x.getObjectAsync`, `x["getObjectAsync"]`.
   *
   * @param target the left side of an assignment
   * @returns the member name, or undefined
   */
  private memberName(target: TS.Expression): string | undefined {
    const ts = this.ts;
    if (ts.isPropertyAccessExpression(target)) {
      return target.name.text;
    }
    if (
      ts.isElementAccessExpression(target) &&
      ts.isStringLiteral(target.argumentExpression)
    ) {
      return target.argumentExpression.text;
    }
    return undefined;
  }

  /**
   * The read method behind a chain of mock calls: the receiver of `.mockX(…)`, itself possibly
   * a `.mockY(…)` call, ends in `spyOn(obj, "name")` or in the member `obj.name`.
   *
   * @param receiver the expression the mock method is called on
   * @returns the member name, or undefined
   */
  private mockedMember(receiver: TS.Expression): string | undefined {
    const ts = this.ts;
    let cur = bare(ts, receiver);
    while (
      ts.isCallExpression(cur) &&
      ts.isPropertyAccessExpression(cur.expression) &&
      (MOCK_IMPLEMENTATION.has(cur.expression.name.text) ||
        MOCK_VALUE.has(cur.expression.name.text))
    ) {
      cur = bare(ts, cur.expression.expression);
    }
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression;
      const isSpy =
        (ts.isIdentifier(callee) && callee.text === "spyOn") ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "spyOn");
      const target = cur.arguments[1];
      if (isSpy && target && ts.isStringLiteralLike(target)) {
        return target.text;
      }
      return undefined;
    }
    return this.memberName(cur);
  }

  /**
   * A stub from the value bound to the member: the implementation as written, wrapped in
   * `vi.fn(…)`/`jest.fn(…)`, in `.bind(…)`, behind an identifier or `this.method` — or a
   * `vi.fn().mockResolvedValue(x)` chain, whose fixed answers are judged instead.
   *
   * @param name the read method's name
   * @param at the node to report at when nothing more precise is found
   * @param value the bound value
   * @returns the stub
   */
  private stubFromValue(name: string, at: TS.Node, value: TS.Expression): Stub {
    const ts = this.ts;
    const values: TS.Expression[] = [];
    let cur = bare(ts, value);
    // `vi.fn(impl).mockResolvedValueOnce(x)`: collect the fixed answers, then keep unwrapping.
    while (
      ts.isCallExpression(cur) &&
      ts.isPropertyAccessExpression(cur.expression) &&
      (MOCK_VALUE.has(cur.expression.name.text) ||
        MOCK_IMPLEMENTATION.has(cur.expression.name.text))
    ) {
      const arg = cur.arguments[0];
      if (arg) {
        if (MOCK_VALUE.has(cur.expression.name.text)) {
          values.push(arg);
        } else {
          return this.finish(name, at, arg, values);
        }
      }
      cur = bare(ts, cur.expression.expression);
    }
    return this.finish(name, at, cur, values);
  }

  /**
   * Resolves the implementation of a stub: `vi.fn(impl)` / `jest.fn(impl)` give `impl`, an
   * empty `vi.fn()` gives nothing, everything else goes through the function resolver.
   *
   * @param name the read method's name
   * @param at the node to report at
   * @param impl the implementation expression
   * @param values fixed answers collected from mock calls
   * @returns the stub
   */
  private finish(
    name: string,
    at: TS.Node,
    impl: TS.Expression,
    values: TS.Expression[],
  ): Stub {
    const ts = this.ts;
    let cur = bare(ts, impl);
    if (
      ts.isCallExpression(cur) &&
      ts.isPropertyAccessExpression(cur.expression) &&
      FN_FACTORIES.has(cur.expression.name.text)
    ) {
      const arg = cur.arguments[0];
      if (!arg) {
        return { name, at, values };
      }
      cur = bare(ts, arg);
    }
    const resolved = this.resolver.resolveFunction(this.file, cur);
    const fn = resolved?.node;
    return {
      name,
      at,
      fn:
        fn && fn.body
          ? (fn as TS.FunctionLikeDeclaration & { body: TS.ConciseBody })
          : undefined,
      values,
    };
  }
}

/**
 * Judges what a stub answers with: a lookup in the store (`store.get(id)`, `objects[id]`), a
 * member the harness holds (`this.instanceObject`), a variable declared outside the stub — all
 * hand out an object the test keeps — against a value the call builds (an object literal,
 * `structuredClone(…)`, `JSON.parse(JSON.stringify(…))`, `null`).
 */
class AnswerJudge {
  /**
   * @param ts the TypeScript compiler API
   */
  constructor(private readonly ts: typeof TS) {}

  /**
   * The expressions a function answers with: the concise body of an arrow, else every
   * `return` in the body outside nested functions.
   *
   * @param fn the function
   * @returns the returned expressions
   */
  answers(
    fn: TS.FunctionLikeDeclaration & { body: TS.ConciseBody },
  ): TS.Expression[] {
    const ts = this.ts;
    if (!ts.isBlock(fn.body)) {
      return [fn.body];
    }
    const out: TS.Expression[] = [];
    const visit = (node: TS.Node): void => {
      if (ts.isReturnStatement(node)) {
        if (node.expression) {
          out.push(node.expression);
        }
        return;
      }
      if (
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isClassLike(node)
      ) {
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return out;
  }

  /**
   * The first sub-expression of an answer that hands out a kept object, or undefined when the
   * answer is built by the call.
   *
   * @param expr the answered expression
   * @param fn the stub's function, when it has one — declarations inside it are followed
   * @param deep true for an object or enum read — then a shallow copy still hands out the kept nested members
   * @returns the offending expression
   */
  keptObject(
    expr: TS.Expression,
    fn: TS.FunctionLikeDeclaration | undefined,
    deep = false,
  ): TS.Expression | undefined {
    this.deep = deep;
    return this.judge(expr, fn, new Set());
  }

  /**
   * Whether a shallow copy is still the kept object: an ioBroker OBJECT carries `common`/`native` as nested objects,
   * so `{ ...kept }` or `Object.assign({}, kept)` hands those out shared (0.15.0, tooling audit 2026-09-24, P8). A
   * state's fields are primitives — there a shallow copy is a copy.
   */
  private deep = false;

  /**
   * @param expr the expression
   * @param fn the enclosing stub function
   * @param seen identifiers already followed (guards against `const a = a`)
   * @returns the offending expression, or undefined
   */
  private judge(
    expr: TS.Expression,
    fn: TS.FunctionLikeDeclaration | undefined,
    seen: Set<string>,
  ): TS.Expression | undefined {
    const ts = this.ts;
    expr = bare(ts, expr);
    if (ts.isAwaitExpression(expr)) {
      return this.judge(expr.expression, fn, seen);
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken
      ) {
        return (
          this.judge(expr.left, fn, seen) ?? this.judge(expr.right, fn, seen)
        );
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        return this.judge(expr.right, fn, seen);
      }
      return undefined;
    }
    if (ts.isConditionalExpression(expr)) {
      return (
        this.judge(expr.whenTrue, fn, seen) ??
        this.judge(expr.whenFalse, fn, seen)
      );
    }
    if (this.deep && ts.isObjectLiteralExpression(expr)) {
      for (const prop of expr.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const kept = this.judge(prop.expression, fn, seen);
          if (kept) {
            return kept;
          }
        }
      }
      return undefined;
    }
    if (
      this.deep &&
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.expression.text === "Object" &&
      expr.expression.name.text === "assign"
    ) {
      for (const arg of expr.arguments.slice(1)) {
        const kept = this.judge(arg, fn, seen);
        if (kept) {
          return kept;
        }
      }
      return undefined;
    }
    if (ts.isCallExpression(expr)) {
      const callee = expr.expression;
      // `Promise.resolve(x)` answers with x.
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Promise" &&
        callee.name.text === "resolve"
      ) {
        const arg = expr.arguments[0];
        return arg ? this.judge(arg, fn, seen) : undefined;
      }
      // `store.get(id)`: a lookup hands out the stored object; any other call builds its value.
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "get" &&
        expr.arguments.length > 0
      ) {
        return expr;
      }
      return undefined;
    }
    if (ts.isElementAccessExpression(expr)) {
      return ts.isArrayLiteralExpression(bare(ts, expr.expression))
        ? undefined
        : expr;
    }
    if (ts.isPropertyAccessExpression(expr)) {
      return expr;
    }
    if (ts.isIdentifier(expr)) {
      if (expr.text === "undefined" || seen.has(expr.text)) {
        return undefined;
      }
      seen.add(expr.text);
      const local = fn ? this.declaredIn(fn, expr.text) : undefined;
      if (local === null) {
        // A parameter of the stub: what the caller passes in, not a kept object.
        return undefined;
      }
      if (local) {
        return local.initializer
          ? this.judge(local.initializer, fn, seen)
          : undefined;
      }
      // Declared outside the stub (the describe block, the module, an import): kept between
      // calls, so every read gets the same object.
      return expr;
    }
    return undefined;
  }

  /**
   * The declaration of a name inside the stub function: a `const`/`let` of the body, or `null`
   * for a parameter.
   *
   * @param fn the stub function
   * @param name the identifier
   * @returns the variable declaration, `null` for a parameter, undefined when not declared here
   */
  private declaredIn(
    fn: TS.FunctionLikeDeclaration,
    name: string,
  ): TS.VariableDeclaration | null | undefined {
    const ts = this.ts;
    for (const param of fn.parameters) {
      if (ts.isIdentifier(param.name) && param.name.text === name) {
        return null;
      }
    }
    let found: TS.VariableDeclaration | undefined;
    const visit = (node: TS.Node): void => {
      if (found) {
        return;
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name
      ) {
        found = node;
        return;
      }
      if (
        node !== fn &&
        (ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node) ||
          ts.isFunctionDeclaration(node))
      ) {
        return;
      }
      ts.forEachChild(node, visit);
    };
    if (fn.body) {
      visit(fn.body);
    }
    return found;
  }
}

/**
 * A stub of an adapter read method answers with a copy of what it holds, as the controller
 * does — never with the stored object itself.
 *
 * Measured 2026-09-17 on a fleet adapter: the test harness answered
 * `getObjectAsync` with `store.objects.get(fullId)`. The repair path under test changed the
 * object it had read and wrote it back — and with a shared reference the change was in the
 * store before the write, so no test could tell a repair that writes from one that does not:
 * the write was invisible to every test. js-controller answers every read with a fresh value
 * (deserialised from the database on each call); a change on what was read reaches the store
 * only through a write. A stub that hands out its own object changes exactly that contract, and
 * every assertion on "what the store holds afterwards" proves nothing.
 *
 * Judged are the test sources (`src/**\/*.test.ts` and everything below `test/`), with the
 * adapter's own compiler: every binding of a read method (`getObject`, `getForeignObject`,
 * `getForeignObjects`, `getObjectView`, `getObjectList`, `getEnum(s)`, `getState`,
 * `getForeignState`, `getStates`, `getForeignStates`, `getAdapterObjects`, each with its
 * `Async` twin) — a property of an object literal or class, a method, an assignment
 * `adapter.getObjectAsync = …`, `vi.fn(impl)`, `.mockImplementation(impl)`,
 * `vi.spyOn(adapter, "getObjectAsync").mockResolvedValue(x)`. What the stub answers with is
 * followed through `Promise.resolve`, `await`, `??`, `||`, `?:` and variables declared in the
 * stub: a lookup (`store.get(id)`, `objects[id]`), a member the harness keeps
 * (`this.instanceObject`) or a variable declared outside the stub hands out a kept object and
 * is reported; an object literal, `structuredClone(…)`, `JSON.parse(JSON.stringify(…))`, any
 * other call, `null` and `undefined` are values the call builds. A callback-form name (`getStates`,
 * `getObject`) is also the API of other libraries a test fakes (`date-holidays` has
 * `getStates(country)`), so it is judged only next to another adapter member or on a receiver
 * called `adapter`/`this`; the `Async` twins always are. The write side (a stub that
 * stores the caller's object) is not judged. Without a loadable `typescript` the check reports
 * that instead of staying silent.
 */
export const readStubCopyCheck: Check = {
  id: "read-stub-copy",
  title:
    "a stub of an adapter read method answers with a copy, never with the stored object itself",
  run(adapterDir: string): Finding[] {
    const ts = typescriptApi();
    const files = listTestFiles(adapterDir);
    if (files.length === 0) {
      return [];
    }
    if (!ts) {
      // Fail closed: a standard that cannot be judged is a finding, not silence.
      return [
        {
          check: readStubCopyCheck.id,
          file: repoPath(adapterDir, files[0] as string),
          message:
            "the test sources could not be parsed: no `typescript` module can be loaded next to this package",
          impact:
            "the check reads the sources with the adapter's own compiler (a dev dependency of every TypeScript adapter) — until it is installed this standard is not judged",
        },
      ];
    }
    const sources = parseSources(ts, adapterDir, files);
    const resolver = new FunctionResolver(ts, sources);
    const judge = new AnswerJudge(ts);
    const findings: Finding[] = [];
    for (const [file, source] of sources) {
      const rel = repoPath(adapterDir, file);
      for (const stub of new StubReader(ts, file, source, resolver).stubs()) {
        const answers = [
          ...stub.values.map((v) => ({ expr: v, fn: undefined })),
          ...(stub.fn
            ? judge.answers(stub.fn).map((expr) => ({ expr, fn: stub.fn }))
            : []),
        ];
        for (const { expr, fn } of answers) {
          const kept = judge.keptObject(expr, fn, !/State/.test(stub.name));
          if (!kept) {
            continue;
          }
          findings.push({
            check: readStubCopyCheck.id,
            file: rel,
            line:
              source.getLineAndCharacterOfPosition(kept.getStart(source)).line +
              1,
            message: `the stub of ${stub.name} answers with the object it keeps (${kept.getText(source)}) instead of a copy`,
            impact:
              "the controller hands every read a fresh value — with a shared reference a change the code makes on what it read is in the store before any write, so no test can tell a missing write from a done one (measured: a repair path's write was invisible to every test); answer with structuredClone(obj) (null stays null)",
          });
          break;
        }
      }
    }
    return findings;
  },
};
