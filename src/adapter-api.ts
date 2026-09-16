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

  /**
   * The nearest enclosing class of a node, when there is one.
   *
   * @param node any node of the file
   * @returns the class, or undefined outside every class
   */
  const enclosingClass = (
    node: TS.Node,
  ): TS.ClassLikeDeclaration | undefined => {
    let current: TS.Node | undefined = node.parent;
    while (current) {
      if (ts.isClassLike(current)) {
        return current;
      }
      current = current.parent;
    }
    return undefined;
  };

  /**
   * Whether a class extends something called `…Adapter` (`utils.Adapter`, `Adapter`).
   *
   * @param cls the class
   * @returns true when its extends clause names an Adapter
   */
  const extendsAdapter = (cls: TS.ClassLikeDeclaration): boolean => {
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
  };

  const visit = (node: TS.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const access = node.expression;
      const receiver = access.expression.getText(source);
      const cls = receiver === "this" ? enclosingClass(node) : undefined;
      calls.push({
        name: access.name.text,
        receiver,
        onAdapter:
          receiverIsAdapter(receiver) ||
          (cls !== undefined && extendsAdapter(cls)),
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
  const exits = (statement: TS.Node): boolean =>
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement);

  // The statement holding `from`, and the block it sits in.
  let statement: TS.Node | undefined = from.node;
  while (
    statement.parent &&
    !ts.isBlock(statement.parent) &&
    !ts.isSourceFile(statement.parent)
  ) {
    if (ts.isFunctionLike(statement.parent)) {
      return undefined; // the call is an expression-bodied arrow function's whole body
    }
    statement = statement.parent;
  }
  for (;;) {
    const block: TS.Node | undefined = statement.parent;
    if (!block || !(ts.isBlock(block) || ts.isSourceFile(block))) {
      return undefined;
    }
    const statements = block.statements;
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
    while (
      statement.parent &&
      !ts.isBlock(statement.parent) &&
      !ts.isSourceFile(statement.parent)
    ) {
      if (ts.isFunctionLike(statement.parent)) {
        return undefined;
      }
      statement = statement.parent;
    }
  }
}
