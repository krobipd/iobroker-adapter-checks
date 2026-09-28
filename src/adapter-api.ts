import { createRequire } from "node:module";
import type TS from "typescript";

/**
 * The TypeScript compiler API, resolved from where this package is installed — that is the
 * adapter's own `typescript`, which every TypeScript adapter carries as a dev dependency. The
 * package itself must not pull in a second compiler: an adapter would then type-check its
 * sources with one version and have its standards judged with another.
 */
let compiler: typeof TS | null | undefined;

/**
 * The installed TypeScript compiler, or undefined when there is none to load.
 *
 * @returns the `typescript` module
 */
export function typescriptApi(): typeof TS | undefined {
  if (compiler === undefined) {
    try {
      compiler = createRequire(import.meta.url)("typescript") as typeof TS;
    } catch {
      compiler = null;
    }
  }
  return compiler ?? undefined;
}

/** One `receiver.method(...)` call in an adapter source file. */
export interface AdapterCall {
  /** The method name, e.g. `delObjectAsync`. */
  name: string;
  /** The receiver as written, e.g. `this`, `adapter`, `this.adapter`, `this.port`. */
  receiver: string;
  /**
   * Whether the receiver is the ioBroker adapter itself: `this` inside a class that extends
   * `…Adapter`, or an identifier / property named `adapter` (`adapter`, `this.adapter`,
   * `ctx.adapter`) — the two forms adapter code and its library classes use.
   */
  onAdapter: boolean;
  /** The arguments as written, whitespace collapsed. */
  args: string[];
  /** 1-based line of the call. */
  line: number;
  /** The call node — for {@link laterOnSamePath}. */
  node: TS.CallExpression;
}

/**
 * Whether the receiver text names the adapter — `adapter` itself, or a property named `adapter`
 * on anything (`this.adapter`, `this.adapter?`, `ctx.adapter`).
 *
 * @param receiver the receiver as written
 * @returns true for the adapter forms
 */
function receiverIsAdapter(receiver: string): boolean {
  return /(?:^|\.)adapter\??$/.test(receiver);
}

/**
 * The nearest enclosing class of a node, when there is one.
 *
 * @param ts the compiler API
 * @param node any node of the file
 * @returns the class, or undefined outside every class
 */
function enclosingClass(
  ts: typeof TS,
  node: TS.Node,
): TS.ClassLikeDeclaration | undefined {
  let current: TS.Node | undefined = node.parent;
  while (current) {
    if (ts.isClassLike(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Whether a class extends something called `…Adapter` (`utils.Adapter`, `Adapter`).
 *
 * @param ts the compiler API
 * @param source the file
 * @param cls the class
 * @returns true when its extends clause names an Adapter
 */
function extendsAdapter(
  ts: typeof TS,
  source: TS.SourceFile,
  cls: TS.ClassLikeDeclaration,
): boolean {
  for (const clause of cls.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue;
    }
    for (const type of clause.types) {
      if (/(?:^|\.)Adapter$/.test(type.expression.getText(source))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether a receiver at a node is the ioBroker adapter: `this` inside a class that extends
 * `…Adapter`, or one of the {@link receiverIsAdapter} forms.
 *
 * @param ts the compiler API
 * @param source the file
 * @param receiver the receiver as written
 * @param node the node the receiver belongs to
 * @returns true when the receiver is the adapter
 */
function receiverOnAdapter(
  ts: typeof TS,
  source: TS.SourceFile,
  receiver: string,
  node: TS.Node,
): boolean {
  if (receiverIsAdapter(receiver)) {
    return true;
  }
  const cls = receiver === "this" ? enclosingClass(ts, node) : undefined;
  return cls !== undefined && extendsAdapter(ts, source, cls);
}

/** One `receiver.name` property access in an adapter source file (not the callee of a call). */
export interface AdapterPropertyAccess {
  /** The property name, e.g. `language`. */
  name: string;
  /** The receiver as written, e.g. `this`, `this.adapter`. */
  receiver: string;
  /** Whether the receiver is the ioBroker adapter itself — same rule as {@link AdapterCall.onAdapter}. */
  onAdapter: boolean;
  /** Whether the access is the target of an assignment (`=`, `??=`, `||=`, `&&=`). */
  write: boolean;
  /** 1-based line of the access. */
  line: number;
}

/** What {@link adapterProperties} reads from one source file. */
export interface AdapterProperties {
  /** Every property access that is not the callee of a call, in source order. */
  accesses: AdapterPropertyAccess[];
  /** Property names a class extending `…Adapter` declares itself (`language: string`, `public dateFormat = …`). */
  declaredOnAdapter: Set<string>;
  /**
   * Names of adapter-option properties written with the literal `true` (`{ useFormatDate: true }`): object literals
   * inside the constructor of a class extending `…Adapter`, or inside the arguments of a call or `new` of something
   * called `…adapter`/`…Adapter` (`utils.adapter({...})`). A `true` flag in any other literal is not an option.
   */
  trueFlags: Set<string>;
}

/**
 * The property accesses of a source file, with whether their receiver is the adapter, plus
 * the properties an adapter class declares itself and the object-literal flags set to `true`.
 *
 * @param text the file
 * @param fileName its name (the extension decides between TS and TSX parsing)
 * @returns the accesses, or undefined when no TypeScript compiler is available
 */
export function adapterProperties(
  text: string,
  fileName: string,
): AdapterProperties | undefined {
  const ts = typescriptApi();
  if (!ts) {
    return undefined;
  }
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result: AdapterProperties = {
    accesses: [],
    declaredOnAdapter: new Set(),
    trueFlags: new Set(),
  };
  /**
   * Whether an object literal can carry the adapter options: it sits in the constructor of a class extending
   * `…Adapter`, or in the arguments of a call / `new` whose callee is called `…adapter` or `…Adapter`.
   *
   * @param node the object literal
   * @returns true in an options position
   */
  const inAdapterOptions = (node: TS.Node): boolean => {
    for (let n: TS.Node | undefined = node.parent; n; n = n.parent) {
      if (
        ts.isConstructorDeclaration(n) &&
        ts.isClassLike(n.parent) &&
        extendsAdapter(ts, source, n.parent)
      ) {
        return true;
      }
      if (
        (ts.isCallExpression(n) || ts.isNewExpression(n)) &&
        /(?:^|\.)[aA]dapter$/.test(n.expression.getText(source)) &&
        (n.arguments ?? []).some((a) => node.pos >= a.pos && node.end <= a.end)
      ) {
        return true;
      }
      if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) {
        return false;
      }
    }
    return false;
  };
  const assignments = new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ]);
  const visit = (node: TS.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      const receiver = node.expression.getText(source);
      const parent = node.parent;
      result.accesses.push({
        name: node.name.text,
        receiver,
        onAdapter: receiverOnAdapter(ts, source, receiver, node),
        write:
          ts.isBinaryExpression(parent) &&
          parent.left === node &&
          assignments.has(parent.operatorToken.kind),
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    } else if (
      ts.isPropertyDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isClassLike(node.parent) &&
      extendsAdapter(ts, source, node.parent)
    ) {
      result.declaredOnAdapter.add(node.name.text);
    } else if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer.kind === ts.SyntaxKind.TrueKeyword &&
      inAdapterOptions(node.parent)
    ) {
      result.trueFlags.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

/**
 * Every method call of a source file, with what a standard needs to judge it: the receiver,
 * whether that receiver is the adapter, the argument texts and the node.
 *
 * @param text the file
 * @param fileName its name (the extension decides between TS and TSX parsing)
 * @returns the calls in source order, or undefined when no TypeScript compiler is available
 */
export function adapterCalls(
  text: string,
  fileName: string,
): AdapterCall[] | undefined {
  const ts = typescriptApi();
  if (!ts) {
    return undefined;
  }
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const calls: AdapterCall[] = [];

  const visit = (node: TS.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const access = node.expression;
      const receiver = access.expression.getText(source);
      calls.push({
        name: access.name.text,
        receiver,
        onAdapter: receiverOnAdapter(ts, source, receiver, node),
        args: node.arguments.map((a) => a.getText(source).replace(/\s+/g, " ")),
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        node,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/**
 * The first call that the code reaches after `from` on the same path through the same
 * function, and that `matches`.
 *
 * The walk goes statement by statement: the statements after the one holding `from` in its
 * block, then — when the block ends — the statements after the block's own statement in the
 * enclosing block, and so on up to the function body. A `return`, `throw`, `break` or
 * `continue` met on the way ends the path: what follows it is not reached from `from`. So a
 * delete that returns (an orphan cleanup) is not paired with a create in a later branch of the
 * same function, while a delete inside `try` IS paired with the create that follows the `try`.
 *
 * @param calls the calls of the file, as {@link adapterCalls} returned them
 * @param from the call to start after
 * @param matches which later call counts
 * @returns that call, or undefined
 */
export function laterOnSamePath(
  calls: readonly AdapterCall[],
  from: AdapterCall,
  matches: (call: AdapterCall) => boolean,
): AdapterCall | undefined {
  const ts = typescriptApi();
  if (!ts) {
    return undefined;
  }
  const contains = (statement: TS.Node, call: AdapterCall): boolean =>
    call.node.pos >= statement.pos && call.node.end <= statement.end;
  // A `case`/`default` clause holds its statements like a block — until 0.15.0 the walk climbed past it to the
  // `switch` and never saw a later call inside the same case (tooling audit 2026-09-24, P4).
  const holdsStatements = (n: TS.Node): boolean =>
    ts.isBlock(n) || ts.isSourceFile(n) || ts.isCaseOrDefaultClause(n);
  const exits = (statement: TS.Node): boolean =>
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement);

  // The statement holding `from`, and the block it sits in.
  let statement: TS.Node | undefined = from.node;
  while (statement.parent && !holdsStatements(statement.parent)) {
    if (ts.isFunctionLike(statement.parent)) {
      return undefined; // the call is an expression-bodied arrow function's whole body
    }
    statement = statement.parent;
  }
  for (;;) {
    const block: TS.Node | undefined = statement.parent;
    if (!block || !holdsStatements(block)) {
      return undefined;
    }
    const statements = (
      block as TS.Block | TS.SourceFile | TS.CaseOrDefaultClause
    ).statements;
    for (
      let i = statements.indexOf(statement as TS.Statement) + 1;
      i < statements.length;
      i++
    ) {
      const later = statements[i] as TS.Statement;
      const hit = calls.find((c) => contains(later, c) && matches(c));
      if (hit) {
        return hit;
      }
      if (exits(later)) {
        return undefined;
      }
    }
    // The block ended without an exit: the path continues after the block's own statement,
    // unless the block is a function body — then the function ends here.
    if (
      ts.isSourceFile(block) ||
      (block.parent && ts.isFunctionLike(block.parent))
    ) {
      return undefined;
    }
    statement = block.parent;
    while (statement.parent && !holdsStatements(statement.parent)) {
      if (ts.isFunctionLike(statement.parent)) {
        return undefined;
      }
      statement = statement.parent;
    }
  }
}
