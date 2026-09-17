import type TS from "typescript";
import { typescriptApi } from "../adapter-api.js";
import {
  FunctionResolver,
  parseSources,
  type ResolvedFunction,
  type Sources,
} from "../sources.js";
import type { Check, Finding } from "../types.js";
import { listSourceFiles, repoPath } from "../util.js";

/** How a caught value was turned into text. */
type Form = "String" | "template" | "cast" | "stringify";

/** One place that renders a tracked value. */
interface Rendering {
  file: string;
  line: number;
  form: Form;
}

/**
 * A value to follow: an identifier (or a `settled.reason` access, written as a dotted name)
 * inside a scope, and where its caught origin is.
 */
interface Tracked {
  file: string;
  scope: TS.Node;
  name: string;
  /** The parameter this value arrived through, when it is a helper's parameter. */
  via?: { fn: string; origin: string };
  /** The words for the value when it is an alias or a settled rejection reason. */
  subject?: string;
  /** Declared through `as Error` / `<Error>`: reading `.message` off it is the cast form. */
  cast?: boolean;
  /**
   * What the name holds: the results of `Promise.allSettled` (`settled`), one of those results
   * (`item`), or a caught value (the default).
   */
  kind?: "settled" | "item";
}

/** The array methods whose callback receives one element. */
const ELEMENT_CALLBACKS = new Set([
  "forEach",
  "map",
  "filter",
  "find",
  "some",
  "every",
  "flatMap",
]);

const ADVICE =
  "route every caught value through one helper that returns text for every thrown value — Error → message, string → itself, other primitives → String(), objects → JSON.stringify inside try/catch with Object.prototype.toString.call as the fallback";

const MESSAGES: Record<Form, string> = {
  String:
    'is rendered with String(): a thrown plain object (a rejected `{ code: "ECONNRESET" }`, an HTTP client\'s error object) becomes `[object Object]`',
  template:
    "is rendered inside a template literal: a thrown plain object becomes `[object Object]`, a thrown symbol throws again",
  cast: "is read as `(… as Error).message`: a thrown string or plain object has no `message`, the text says `undefined`",
  stringify:
    "is passed to JSON.stringify outside try/catch: a circular structure (an error carrying the response it came from) throws inside the catch block, and a symbol yields undefined",
};

/**
 * A caught value becomes text through a helper that handles every thrown value — never
 * through `String()`, a template literal, an `as Error` cast or a bare `JSON.stringify`.
 *
 * JavaScript lets code throw anything. `String(err)` and `${err}` render a thrown plain
 * object — a rejected `{ code: "ECONNRESET" }`, the error object of an HTTP client — as
 * `[object Object]`, so the log line and the Sentry event carry nothing; `${err}` on a thrown
 * symbol throws a second time, inside the catch block. `(err as Error).message` is the
 * template's shape and reads `undefined` off a thrown string. `JSON.stringify(err)` is the right
 * branch for an object but throws on a circular structure and returns undefined for a symbol —
 * it belongs inside try/catch with `Object.prototype.toString.call(err)` as the fallback. One
 * helper carries all of that; the inline ternary `err instanceof Error ? err.message :
 * String(err)` carries none of it.
 *
 * Caught values are the variable of a `catch` clause, the parameter of a `.catch(…)` or
 * `.then(…, …)` rejection callback, and every parameter a caught value is passed to — by name in
 * the same file or through a relative import, so a helper is judged wherever it lives. Rendering
 * inside a branch that cannot hold an object is fine: `typeof err !== "object"`, `typeof err ===
 * "string"`, `err === null`, `err instanceof Error`, also as an early `return` before the
 * rendering. Judged with the TypeScript compiler of the adapter; without a loadable
 * `typescript` the check reports that instead of staying silent.
 */
export const caughtValueTextCheck: Check = {
  id: "caught-value-text",
  title:
    "a caught value becomes text through a helper that handles every thrown value, not through String(), a template, an `as Error` cast or a bare JSON.stringify",
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
          check: caughtValueTextCheck.id,
          file: repoPath(adapterDir, files[0] as string),
          message:
            "the sources could not be parsed: no `typescript` module can be loaded next to this package",
          impact:
            "the check reads the sources with the adapter's own compiler (a dev dependency of every TypeScript adapter) — until it is installed this standard is not judged",
        },
      ];
    }
    const sources: Sources = parseSources(ts, adapterDir, files);
    const analysis = new Analysis(ts, sources, adapterDir);
    const findings: Finding[] = [];
    for (const r of analysis.renderings()) {
      findings.push({
        check: caughtValueTextCheck.id,
        file: repoPath(adapterDir, r.file),
        line: r.line,
        message: `${r.subject} ${MESSAGES[r.form]}`,
        impact: ADVICE,
      });
    }
    return findings;
  },
};

/** A rendering with the words that name the value. */
interface Reported extends Rendering {
  subject: string;
}

/**
 * The walk over one adapter: seeds every caught value, follows it into the helpers it is
 * passed to, and collects each place it is rendered without a guard.
 */
class Analysis {
  private readonly queue: Tracked[] = [];
  private readonly seen = new Set<string>();
  private readonly out: Reported[] = [];
  private readonly reported = new Set<string>();

  private readonly resolver: FunctionResolver;

  constructor(
    private readonly ts: typeof TS,
    private readonly sources: Sources,
    private readonly adapterDir: string,
  ) {
    this.resolver = new FunctionResolver(ts, sources);
  }

  /**
   * Every guarded-less rendering of a caught value in the adapter, in file order.
   *
   * @returns the renderings, each with the subject to name in the finding
   */
  renderings(): Reported[] {
    for (const [file, source] of this.sources) {
      this.seed(file, source);
    }
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      this.follow(next);
    }
    return this.out.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    );
  }

  /**
   * The caught values a file introduces: `catch (e)`, `.catch(cb)`, `.then(ok, cb)`.
   *
   * @param file the absolute path
   * @param source its syntax tree
   */
  private seed(file: string, source: TS.SourceFile): void {
    const ts = this.ts;
    const visit = (node: TS.Node): void => {
      if (ts.isCatchClause(node) && node.variableDeclaration) {
        const name = node.variableDeclaration.name;
        if (ts.isIdentifier(name)) {
          this.track({ file, scope: node.block, name: name.text });
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text;
        const handler =
          method === "catch"
            ? node.arguments[0]
            : method === "then"
              ? node.arguments[1]
              : undefined;
        if (handler) {
          this.trackHandler(
            file,
            handler,
            `the rejection handler at ${this.where(file, node)}`,
          );
        }
        if (
          node.expression.getText(source).replace(/\s+/g, "") ===
          "Promise.allSettled"
        ) {
          this.seedSettled(file, node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  /**
   * Follow a function passed as a rejection handler: its first parameter is a caught value.
   *
   * @param file the file of the call
   * @param handler the argument as written
   * @param origin where the value comes from, for the finding
   */
  private trackHandler(
    file: string,
    handler: TS.Expression,
    origin: string,
  ): void {
    const fn = this.resolver.resolveFunction(file, handler);
    if (!fn) {
      return;
    }
    this.trackParameter(fn, 0, origin);
  }

  /**
   * The results of `Promise.allSettled(…)`: the variable an awaited call is assigned to, or the
   * first parameter of its `.then(…)` callback. Each rejected result carries the thrown value
   * as `reason`.
   *
   * @param file the file of the call
   * @param call the `Promise.allSettled(…)` call
   */
  private seedSettled(file: string, call: TS.CallExpression): void {
    const ts = this.ts;
    const origin = `Promise.allSettled at ${this.where(file, call)}`;
    const awaited = call.parent;
    if (
      ts.isAwaitExpression(awaited) &&
      ts.isVariableDeclaration(awaited.parent) &&
      ts.isIdentifier(awaited.parent.name)
    ) {
      this.track({
        file,
        scope: this.blockOf(awaited.parent),
        name: awaited.parent.name.text,
        kind: "settled",
        subject: origin,
      });
      return;
    }
    const then = call.parent;
    if (
      ts.isPropertyAccessExpression(then) &&
      then.name.text === "then" &&
      ts.isCallExpression(then.parent) &&
      then.parent.arguments[0]
    ) {
      const fn = this.resolver.resolveFunction(file, then.parent.arguments[0]);
      if (fn) {
        this.trackElement(fn, "settled", origin);
      }
    }
  }

  /**
   * Track the first parameter of a callback as a settled-results list or one settled result.
   *
   * @param fn the callback and its file
   * @param kind what the parameter holds
   * @param subject the words for its origin
   */
  private trackElement(
    fn: ResolvedFunction,
    kind: "settled" | "item",
    subject: string,
  ): void {
    const param = fn.node.parameters[0];
    if (!param || !this.ts.isIdentifier(param.name) || !fn.node.body) {
      return;
    }
    this.track({
      file: fn.file,
      scope: fn.node.body,
      name: param.name.text,
      kind,
      subject,
    });
  }

  /**
   * The block (or function body, or file) a declaration is visible in.
   *
   * @param node the declaration
   * @returns the nearest enclosing block-like node
   */
  private blockOf(node: TS.Node): TS.Node {
    const ts = this.ts;
    let cur: TS.Node = node;
    while (cur.parent && !ts.isBlock(cur) && !ts.isSourceFile(cur)) {
      cur = cur.parent;
    }
    return cur;
  }

  /**
   * Track the n-th parameter of a function as a caught value.
   *
   * @param fn the function and its file
   * @param fn.file the absolute path of the file that declares it
   * @param fn.node the function
   * @param index the parameter position
   * @param origin where the value comes from, for the finding
   */
  private trackParameter(
    fn: ResolvedFunction,
    index: number,
    origin: string,
  ): void {
    const param = fn.node.parameters[index];
    if (!param || !this.ts.isIdentifier(param.name) || !fn.node.body) {
      return;
    }
    this.track({
      file: fn.file,
      scope: fn.node.body,
      name: param.name.text,
      via: { fn: this.resolver.functionName(fn.node), origin },
    });
  }

  /**
   * Queue a value once per scope and name.
   *
   * @param tracked the value
   */
  private track(tracked: Tracked): void {
    const key = `${tracked.file}:${tracked.scope.pos}:${tracked.scope.end}:${tracked.name}`;
    if (this.seen.has(key)) {
      return;
    }
    this.seen.add(key);
    this.queue.push(tracked);
  }

  /**
   * Walk a scope for every use of the tracked name: renderings become findings, calls with the
   * value as an argument track the callee's parameter.
   *
   * @param tracked the value
   */
  private follow(tracked: Tracked): void {
    const ts = this.ts;
    const source = this.sources.get(tracked.file) as TS.SourceFile;
    const head = tracked.name.split(".")[0] as string;
    const visit = (node: TS.Node): void => {
      if (
        node !== tracked.scope &&
        ts.isFunctionLike(node) &&
        this.declaresParameter(node, head)
      ) {
        return; // shadowed
      }
      if (head === tracked.name) {
        if (
          ts.isIdentifier(node) &&
          node.text === tracked.name &&
          this.isReference(node)
        ) {
          this.use(tracked, source, node);
        }
      } else if (
        ts.isPropertyAccessExpression(node) &&
        node.getText(source).replace(/\s+/g, "") === tracked.name
      ) {
        this.use(tracked, source, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(tracked.scope);
  }

  /**
   * One reference of a tracked value: classify what its parent does with it.
   *
   * @param tracked the value
   * @param source the file
   * @param ref the identifier
   */
  private use(
    tracked: Tracked,
    source: TS.SourceFile,
    ref: TS.Expression,
  ): void {
    const ts = this.ts;
    const parent = ref.parent;
    if (tracked.kind === "settled") {
      this.useSettled(tracked, source, ref);
      return;
    }
    if (tracked.kind === "item") {
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === ref &&
        parent.name.text === "reason"
      ) {
        // `r.reason` of a rejected result is the thrown value — followed like a caught one.
        this.use(
          {
            file: tracked.file,
            scope: tracked.scope,
            name: `${tracked.name}.reason`,
            subject: `the rejection reason \`${tracked.name}.reason\` (${tracked.subject})`,
          },
          source,
          parent,
        );
      }
      return;
    }
    if (this.aliased(tracked, source, ref)) {
      return;
    }
    if (
      tracked.cast &&
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === ref &&
      parent.name.text === "message"
    ) {
      this.report(tracked, source, ref, "cast");
      return;
    }
    if (ts.isCallExpression(parent) && parent.arguments.includes(ref)) {
      const callee = parent.expression;
      const index = parent.arguments.indexOf(ref);
      if (ts.isIdentifier(callee) && callee.text === "String" && index === 0) {
        this.report(tracked, source, ref, "String");
        return;
      }
      if (
        index === 0 &&
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "JSON" &&
        callee.name.text === "stringify"
      ) {
        if (!this.insideTry(ref)) {
          this.report(tracked, source, ref, "stringify");
        }
        return;
      }
      const fn = this.resolver.resolveFunction(tracked.file, callee);
      if (fn) {
        this.trackParameter(
          fn,
          index,
          `${this.subject(tracked)} at ${this.where(tracked.file, ref)}`,
        );
      }
      return;
    }
    if (ts.isTemplateSpan(parent) && parent.expression === ref) {
      this.report(tracked, source, ref, "template");
      return;
    }
    let cast: TS.Node = parent;
    if (ts.isAsExpression(cast) || ts.isTypeAssertionExpression(cast)) {
      while (cast.parent && ts.isParenthesizedExpression(cast.parent)) {
        cast = cast.parent;
      }
      const access = cast.parent;
      if (
        access &&
        ts.isPropertyAccessExpression(access) &&
        access.expression === cast &&
        access.name.text === "message"
      ) {
        this.report(tracked, source, ref, "cast");
      }
    }
  }

  /**
   * One reference of a settled-results list: `for (const r of results)` and the element
   * callbacks (`results.forEach(r => …)`, `.map`, `.filter`, …) hand one result on.
   *
   * @param tracked the list
   * @param source the file
   * @param ref the reference
   */
  private useSettled(
    tracked: Tracked,
    source: TS.SourceFile,
    ref: TS.Expression,
  ): void {
    const ts = this.ts;
    const parent = ref.parent;
    if (
      ts.isForOfStatement(parent) &&
      parent.expression === ref &&
      ts.isVariableDeclarationList(parent.initializer)
    ) {
      const decl = parent.initializer.declarations[0];
      if (decl && ts.isIdentifier(decl.name)) {
        this.track({
          file: tracked.file,
          scope: parent.statement,
          name: decl.name.text,
          kind: "item",
          subject: tracked.subject,
        });
      }
      return;
    }
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === ref &&
      ELEMENT_CALLBACKS.has(parent.name.text) &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent &&
      parent.parent.arguments[0]
    ) {
      const fn = this.resolver.resolveFunction(
        tracked.file,
        parent.parent.arguments[0],
      );
      if (fn) {
        this.trackElement(fn, "item", tracked.subject as string);
      }
    }
  }

  /**
   * A declaration that copies the value under a new name — `const err = error as Error`,
   * `const e = reason` — hands the tracking on to that name; through a cast, reading
   * `.message` off the new name is the cast form. A copy taken where a guard already rules an
   * object out (or proves an Error) is safe and not followed.
   *
   * @param tracked the value
   * @param source the file
   * @param ref the reference
   * @returns true when the reference is such an initializer
   */
  private aliased(
    tracked: Tracked,
    source: TS.SourceFile,
    ref: TS.Expression,
  ): boolean {
    const ts = this.ts;
    let cast = tracked.cast === true;
    let node: TS.Node = ref;
    while (
      node.parent &&
      (ts.isParenthesizedExpression(node.parent) ||
        ts.isNonNullExpression(node.parent) ||
        ts.isAsExpression(node.parent) ||
        ts.isTypeAssertionExpression(node.parent))
    ) {
      if (
        ts.isAsExpression(node.parent) ||
        ts.isTypeAssertionExpression(node.parent)
      ) {
        cast = true;
      }
      node = node.parent;
    }
    const decl = node.parent;
    if (
      !decl ||
      !ts.isVariableDeclaration(decl) ||
      decl.initializer !== node ||
      !ts.isIdentifier(decl.name)
    ) {
      return false;
    }
    const facts = this.narrowing(ref, tracked.scope, tracked.name);
    if (!facts.isError && !facts.notObject) {
      this.track({
        file: tracked.file,
        scope: this.blockOf(decl),
        name: decl.name.text,
        subject: `${this.subject(tracked)} (as \`${decl.name.text}\`)`,
        cast,
      });
    }
    return true;
  }

  /**
   * Record a rendering unless a guard on the path makes it safe.
   *
   * @param tracked the value
   * @param source the file
   * @param ref the identifier being rendered
   * @param form how it is rendered
   */
  private report(
    tracked: Tracked,
    source: TS.SourceFile,
    ref: TS.Expression,
    form: Form,
  ): void {
    const facts = this.narrowing(ref, tracked.scope, tracked.name);
    if (facts.isError || (form !== "cast" && facts.notObject)) {
      return;
    }
    const line =
      source.getLineAndCharacterOfPosition(ref.getStart(source)).line + 1;
    const key = `${tracked.file}:${line}:${form}`;
    if (this.reported.has(key)) {
      return;
    }
    this.reported.add(key);
    this.out.push({
      file: tracked.file,
      line,
      form,
      subject: this.subject(tracked),
    });
  }

  /**
   * The words for a tracked value in a finding.
   *
   * @param tracked the value
   * @returns "the caught value `e`" or "the parameter `err` of errText, which receives …"
   */
  private subject(tracked: Tracked): string {
    if (tracked.via) {
      return `the parameter \`${tracked.name}\` of ${tracked.via.fn} (which receives ${tracked.via.origin})`;
    }
    return tracked.subject ?? `the caught value \`${tracked.name}\``;
  }

  /**
   * "file:line" of a node, with the repository-relative file name.
   *
   * @param file the absolute path
   * @param node the node
   * @returns the location text
   */
  private where(file: string, node: TS.Node): string {
    const source = this.sources.get(file) as TS.SourceFile;
    const line =
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    // repoPath, never a split on "/": the walker returns native separators, and a finding on
    // Windows would otherwise carry the absolute temp path (the 0.11.1 release run found it).
    return `${repoPath(this.adapterDir, file)}:${line}`;
  }

  /**
   * Whether an identifier is a value reference (not a declaration name, property name or label).
   *
   * @param id the identifier
   * @returns true for a read of the variable
   */
  private isReference(id: TS.Identifier): boolean {
    const ts = this.ts;
    const p = id.parent;
    if (ts.isPropertyAccessExpression(p) && p.name === id) {
      return false;
    }
    if (ts.isPropertyAssignment(p) && p.name === id) {
      return false;
    }
    if (
      (ts.isVariableDeclaration(p) ||
        ts.isParameter(p) ||
        ts.isBindingElement(p)) &&
      p.name === id
    ) {
      return false;
    }
    if (ts.isFunctionLike(p) && p.name === id) {
      return false;
    }
    if (
      ts.isImportSpecifier(p) ||
      ts.isExportSpecifier(p) ||
      ts.isLabeledStatement(p)
    ) {
      return false;
    }
    if (ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p)) {
      return false;
    }
    return true;
  }

  /**
   * Whether a function declares a parameter of that name (which shadows the tracked value).
   *
   * @param fn the function
   * @param name the name
   * @returns true when shadowed
   */
  private declaresParameter(
    fn: TS.SignatureDeclaration,
    name: string,
  ): boolean {
    return fn.parameters.some(
      (p) => this.ts.isIdentifier(p.name) && p.name.text === name,
    );
  }

  /**
   * Whether a node sits inside the `try` block of a try statement of the same function — a `try`
   * around a callback's definition does not run when the callback runs.
   *
   * @param node the node
   * @returns true when a try/catch protects it
   */
  private insideTry(node: TS.Node): boolean {
    const ts = this.ts;
    for (
      let cur = node.parent;
      cur && !ts.isFunctionLike(cur);
      cur = cur.parent
    ) {
      if (ts.isTryStatement(cur) && this.contains(cur.tryBlock, node)) {
        return true;
      }
    }
    return false;
  }

  /**
   * What the branches and the early exits around a node say about the tracked value.
   *
   * @param node the rendering
   * @param scope the tracked scope
   * @param name the tracked name
   * @returns the facts that hold at the node
   */
  private narrowing(node: TS.Node, scope: TS.Node, name: string): Facts {
    const ts = this.ts;
    const facts: Facts = { notObject: false, isError: false };
    let child: TS.Node = node;
    for (
      let cur = node.parent;
      cur && child !== scope;
      child = cur, cur = cur.parent
    ) {
      if (ts.isIfStatement(cur)) {
        if (child === cur.thenStatement) {
          merge(facts, this.judge(cur.expression, "then", name));
        } else if (child === cur.elseStatement) {
          merge(facts, this.judge(cur.expression, "else", name));
        }
      } else if (ts.isConditionalExpression(cur)) {
        if (child === cur.whenTrue) {
          merge(facts, this.judge(cur.condition, "then", name));
        } else if (child === cur.whenFalse) {
          merge(facts, this.judge(cur.condition, "else", name));
        }
      } else if (ts.isBinaryExpression(cur) && child === cur.right) {
        if (cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
          merge(facts, this.judge(cur.left, "then", name));
        } else if (cur.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
          merge(facts, this.judge(cur.left, "else", name));
        }
      } else if (ts.isBlock(cur) || ts.isSourceFile(cur)) {
        // An earlier `if (C) return/throw` in this block narrows what follows it.
        const statements = cur.statements;
        const at = statements.findIndex((s) => this.contains(s, node));
        for (let i = 0; i < at; i++) {
          const s = statements[i] as TS.Statement;
          if (
            ts.isIfStatement(s) &&
            !s.elseStatement &&
            this.exits(s.thenStatement)
          ) {
            merge(facts, this.judge(s.expression, "else", name));
          }
        }
      }
    }
    return facts;
  }

  /**
   * Whether a statement always leaves the enclosing function or loop body.
   *
   * @param s the statement
   * @returns true for return/throw/break/continue, a block ending in one, or a try whose arms all exit
   */
  private exits(s: TS.Statement): boolean {
    const ts = this.ts;
    if (
      ts.isReturnStatement(s) ||
      ts.isThrowStatement(s) ||
      ts.isBreakStatement(s) ||
      ts.isContinueStatement(s)
    ) {
      return true;
    }
    if (ts.isBlock(s)) {
      const last = s.statements[s.statements.length - 1];
      return last !== undefined && this.exits(last);
    }
    if (ts.isTryStatement(s)) {
      // try/catch that returns on both arms (the object branch of a text helper), or a finally that exits.
      const arms =
        this.exits(s.tryBlock) &&
        (s.catchClause === undefined || this.exits(s.catchClause.block));
      return (
        arms || (s.finallyBlock !== undefined && this.exits(s.finallyBlock))
      );
    }
    return false;
  }

  /**
   * What a condition says about the value on one of its branches.
   *
   * @param cond the condition
   * @param branch which branch the node is on
   * @param name the tracked name
   * @returns the facts that hold on that branch
   */
  private judge(
    cond: TS.Expression,
    branch: "then" | "else",
    name: string,
  ): Facts {
    const ts = this.ts;
    while (ts.isParenthesizedExpression(cond)) {
      cond = cond.expression;
    }
    if (
      ts.isPrefixUnaryExpression(cond) &&
      cond.operator === ts.SyntaxKind.ExclamationToken
    ) {
      const inner = cond.operand;
      if (this.names(inner, name)) {
        // `!e`: on the then branch e is null/undefined/""/0/false — none of them an object.
        return { notObject: branch === "then", isError: false };
      }
      return this.judge(inner, branch === "then" ? "else" : "then", name);
    }
    if (ts.isBinaryExpression(cond)) {
      const op = cond.operatorToken.kind;
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken
      ) {
        const l = this.judge(cond.left, branch, name);
        const r = this.judge(cond.right, branch, name);
        const conjunction =
          (op === ts.SyntaxKind.AmpersandAmpersandToken) ===
          (branch === "then");
        // then-branch of A && B: both hold → a fact from either side holds.
        // then-branch of A || B (or else-branch of A && B): only one side is known → both must say it.
        return conjunction
          ? {
              notObject: l.notObject || r.notObject,
              isError: l.isError || r.isError,
            }
          : {
              notObject: l.notObject && r.notObject,
              isError: l.isError && r.isError,
            };
      }
      return this.atom(cond, branch, name);
    }
    return { notObject: false, isError: false };
  }

  /**
   * One comparison: `typeof e === "…"`, `e === null`, `e instanceof Error`.
   *
   * @param cond the binary expression
   * @param branch which branch
   * @param name the tracked name
   * @returns the facts
   */
  private atom(
    cond: TS.BinaryExpression,
    branch: "then" | "else",
    name: string,
  ): Facts {
    const ts = this.ts;
    const none: Facts = { notObject: false, isError: false };
    const op = cond.operatorToken.kind;
    const equals =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken;
    const differs =
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken;
    const isName = (e: TS.Expression): boolean => this.names(e, name);
    if (op === ts.SyntaxKind.InstanceOfKeyword && isName(cond.left)) {
      const cls = cond.right.getText();
      const errorLike = /(^|\.)(\w*Error|\w*Exception)$/.test(cls);
      return { notObject: false, isError: branch === "then" && errorLike };
    }
    if (!equals && !differs) {
      return none;
    }
    const sides = [cond.left, cond.right];
    for (const [a, b] of [
      [sides[0], sides[1]],
      [sides[1], sides[0]],
    ] as [TS.Expression, TS.Expression][]) {
      if (
        ts.isTypeOfExpression(a) &&
        isName(a.expression) &&
        ts.isStringLiteral(b)
      ) {
        const type = b.text;
        // "object" on the then branch of === or the else branch of !== is the object case;
        // every other primitive name (and "function") on those branches cannot be an object.
        const positive =
          (equals && branch === "then") || (differs && branch === "else");
        return {
          notObject: positive ? type !== "object" : type === "object",
          isError: false,
        };
      }
      if (
        isName(a) &&
        (b.kind === ts.SyntaxKind.NullKeyword ||
          (ts.isIdentifier(b) && b.text === "undefined"))
      ) {
        const positive =
          (equals && branch === "then") || (differs && branch === "else");
        return { notObject: positive, isError: false };
      }
    }
    return none;
  }

  /**
   * Whether an expression is the tracked name — an identifier, or a dotted access such as
   * `r.reason` written without spaces.
   *
   * @param e the expression
   * @param name the tracked name
   * @returns true when the expression reads the tracked value
   */
  private names(e: TS.Expression, name: string): boolean {
    const ts = this.ts;
    while (ts.isParenthesizedExpression(e)) {
      e = e.expression;
    }
    if (ts.isIdentifier(e)) {
      return e.text === name;
    }
    return (
      ts.isPropertyAccessExpression(e) &&
      e.getText().replace(/\s+/g, "") === name
    );
  }

  /**
   * Whether a node lies within another.
   *
   * @param outer the container
   * @param inner the node
   * @returns true when inner is inside outer
   */
  private contains(outer: TS.Node, inner: TS.Node): boolean {
    return inner.pos >= outer.pos && inner.end <= outer.end;
  }
}

/** What is known about the tracked value at a place in the code. */
interface Facts {
  /** The value cannot be a non-Error object here. */
  notObject: boolean;
  /** The value is an Error here. */
  isError: boolean;
}

/**
 * Add facts (a fact known on any enclosing branch holds).
 *
 * @param into the accumulated facts
 * @param from the facts of one guard
 */
function merge(into: Facts, from: Facts): void {
  into.notObject ||= from.notObject;
  into.isError ||= from.isError;
}
