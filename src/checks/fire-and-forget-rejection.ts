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

const IMPACT =
  "a rejection nobody receives is an unhandled rejection: js-controller logs it and terminates the instance, and whatever the call was in the middle of writing is lost. A fire-and-forget call needs the whole callee body inside try/catch (guards before it that cannot throw are fine), or a `.catch(…)` on the call";

/** One place a callee is dropped with `void`. */
interface CallSite {
  file: string;
  line: number;
}

/**
 * A promise dropped with `void` has a receiver for its rejection: the callee's body is one
 * try/catch, or the call chain ends in `.catch(…)`.
 *
 * `void this.refresh()` says "I do not wait for this" — it does not say "I do not care whether
 * it fails". The promise still rejects, and with nobody attached that rejection is an unhandled
 * rejection, which js-controller answers by terminating the instance. The fleet rule for every
 * async handler (top-level try/catch in the body, never `.catch()` at the call site) covers
 * this when the WHOLE body is inside the try. Two shapes look covered and are not, both
 * measured 2026-09 on a fleet adapter: a statement that can throw before the `try` (`const c =
 * this.deps.rebuild(t)` ahead of it) or after the `catch` (`await this.refreshZone(zone)`
 * behind it) — and a `.then(cb)` on the dropped call, whose callback rejects with no receiver
 * either. A `try` in the vicinity is not the standard; the try that encloses every statement
 * that can throw is.
 *
 * Judged with the TypeScript compiler of the adapter, below `src/`: for every `void <call>` the
 * chain is read first — a `.catch(…)` or a two-argument `.then(…, …)` anywhere in it is a
 * receiver; a `.then(…)`/`.finally(…)` chain without one is reported at the call site. A bare
 * call is followed to its callee — a method of the enclosing class (`this.x`), a function of
 * the file or behind a relative import, an arrow/function expression, an immediately invoked
 * `(async () => …)()` — when that callee is `async`; a callee that cannot be resolved (an
 * adapter-core method, a library) is not judged. The callee body is one try/catch with a catch
 * clause: statements before the `try` and after it may not contain a call, `new`, `await`,
 * `throw` or `yield` (a guard like `if (!this.ready) return;` is fine), an expression-bodied
 * arrow counts as a body without try, and a catch clause that rethrows is no receiver. Each
 * callee is reported once, at the statement that breaks the rule, naming its call sites.
 * Without a loadable `typescript` the check reports that instead of staying silent.
 */
export const fireAndForgetRejectionCheck: Check = {
  id: "fire-and-forget-rejection",
  title:
    "a promise dropped with `void` has a receiver for its rejection: the callee's body is one try/catch, or the chain ends in .catch()",
  run(adapterDir: string): Finding[] {
    const ts = typescriptApi();
    const files = listSourceFiles(adapterDir);
    if (files.length === 0) {
      return [];
    }
    if (!ts) {
      // Fail closed: a standard that cannot be judged is a finding, not silence.
      return [
        {
          check: fireAndForgetRejectionCheck.id,
          file: repoPath(adapterDir, files[0] as string),
          message:
            "the sources could not be parsed: no `typescript` module can be loaded next to this package",
          impact:
            "the check reads the sources with the adapter's own compiler (a dev dependency of every TypeScript adapter) — until it is installed this standard is not judged",
        },
      ];
    }
    const sources = parseSources(ts, adapterDir, files);
    const resolver = new FunctionResolver(ts, sources);
    const judge = new Judge(ts, sources, resolver);
    const findings: Finding[] = [];
    /** Callees already judged, with their call sites — one finding per callee. */
    const callees = new Map<
      TS.Node,
      { fn: ResolvedFunction; sites: CallSite[] }
    >();

    for (const [file, source] of sources) {
      const rel = repoPath(adapterDir, file);
      const visit = (node: TS.Node): void => {
        if (ts.isVoidExpression(node)) {
          const line =
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1;
          const chain = readChain(ts, node.expression);
          if (chain.handled || !chain.root) {
            // a `.catch(…)` or `.then(…, onRejected)` receives the rejection; `void 0` drops nothing
          } else if (chain.links.length > 0) {
            const risk = judge.chainRisk(file, chain);
            if (risk) {
              findings.push({
                check: fireAndForgetRejectionCheck.id,
                file: rel,
                line,
                message: `\`void … .${chain.links.join("(…).")}(…)\` without \`.catch(…)\`: ${risk} has no receiver`,
                impact: IMPACT,
              });
            }
          } else {
            // a bare call — what can reject is the callee; one the check cannot resolve (an
            // adapter-core method, a library) is not judged
            const fn = resolver.resolveFunction(file, chain.root.expression);
            if (fn) {
              const known = callees.get(fn.node);
              if (known) {
                known.sites.push({ file: rel, line });
              } else {
                callees.set(fn.node, { fn, sites: [{ file: rel, line }] });
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    for (const { fn, sites } of callees.values()) {
      const gap = judge.gap(fn);
      if (!gap) {
        continue;
      }
      const where = sites.map((s) => `${s.file}:${s.line}`).join(", ");
      findings.push({
        check: fireAndForgetRejectionCheck.id,
        file: repoPath(adapterDir, fn.file),
        line: gap.line,
        message: `${resolver.functionName(fn.node)} is dropped with \`void\` at ${where}, and ${gap.what}`,
        impact: IMPACT,
      });
    }
    return findings.sort(
      (a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0),
    );
  },
};

/** What a `void` expression drops: the promise-method chain and the call at its root. */
interface Chain {
  /** The `.then`/`.catch`/`.finally` links, innermost first. */
  links: string[];
  /** The callbacks of the `.then` links, innermost first. */
  thenCallbacks: TS.Expression[];
  /** Whether a link receives the rejection. */
  handled: boolean;
  /** The call the chain starts from, when the dropped expression is a call. */
  root?: TS.CallExpression;
}

/**
 * Read the promise-method chain of a dropped expression.
 *
 * @param ts the TypeScript compiler API
 * @param expr the operand of `void`
 * @returns the chain
 */
function readChain(ts: typeof TS, expr: TS.Expression): Chain {
  while (ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }
  const links: string[] = [];
  const thenCallbacks: TS.Expression[] = [];
  let handled = false;
  let cur: TS.Expression = expr;
  while (
    ts.isCallExpression(cur) &&
    ts.isPropertyAccessExpression(cur.expression) &&
    ["then", "catch", "finally"].includes(cur.expression.name.text)
  ) {
    const method = cur.expression.name.text;
    if (
      (method === "catch" && cur.arguments.length >= 1) ||
      (method === "then" && cur.arguments.length >= 2)
    ) {
      handled = true;
    }
    if (method === "then" && cur.arguments[0]) {
      thenCallbacks.unshift(cur.arguments[0]);
    }
    links.unshift(method);
    cur = cur.expression.expression;
    while (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    }
  }
  return {
    links,
    thenCallbacks,
    handled,
    root: ts.isCallExpression(cur) ? cur : undefined,
  };
}

/**
 * Whether a function is declared `async`.
 *
 * @param ts the TypeScript compiler API
 * @param fn the function
 * @returns true for `async`
 */
function isAsync(ts: typeof TS, fn: TS.FunctionLikeDeclaration): boolean {
  return (
    ts.canHaveModifiers(fn) &&
    (ts.getModifiers(fn) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
    )
  );
}

/** The first place a callee body lets a rejection escape. */
interface Gap {
  line: number;
  what: string;
}

/**
 * Judges callee bodies: the first place a body lets a rejection escape, following an `await`
 * or a `return` into the adapter's own async functions — an awaited callee whose body has no
 * gap of its own cannot reject, so the await is no risk. Each function is judged once.
 */
class Judge {
  private readonly gaps = new Map<TS.Node, Gap | undefined>();

  constructor(
    private readonly ts: typeof TS,
    private readonly sources: Sources,
    private readonly resolver: FunctionResolver,
  ) {}

  /**
   * The first place a callee body lets a rejection escape: an `await`, a `for await`, a `yield`,
   * a `throw` or a returned call that no try/catch of the body protects — inside a `try` without
   * catch clause, inside a catch clause (a rethrow), before or after the try, or in a body that
   * has no try at all.
   *
   * @param fn the callee and its file
   * @returns the gap, or undefined when every rejection has a receiver
   */
  gap(fn: ResolvedFunction): Gap | undefined {
    const ts = this.ts;
    if (this.gaps.has(fn.node)) {
      return this.gaps.get(fn.node);
    }
    // A cycle (a function that awaits itself, directly or through others) is judged by the rest
    // of its body: while it is being judged, its own await counts as received.
    this.gaps.set(fn.node, undefined);
    const body = fn.node.body;
    if (!body) {
      return undefined;
    }
    const source = this.sources.get(fn.file) as TS.SourceFile;
    // An expression body hands its value back like a `return`: a call there is a returned promise.
    const returned =
      !ts.isBlock(body) &&
      returnsCall(ts, body) &&
      this.rejects(fn.file, body, false);
    const hit = returned ? body : this.escapes(fn.file, body);
    let gap: Gap | undefined;
    if (hit) {
      const line =
        source.getLineAndCharacterOfPosition(hit.getStart(source)).line + 1;
      const text = hit.getText(source).replace(/\s+/g, " ");
      const shown = `\`${text.length > 60 ? `${text.slice(0, 57)}…` : text}\``;
      const verb = ts.isThrowStatement(hit)
        ? "throws"
        : returned || ts.isReturnStatement(hit)
          ? "returns a promise that can reject"
          : ts.isCallExpression(hit)
            ? "can throw"
            : "can reject";
      let hasTry = false;
      const look = (n: TS.Node): void => {
        if (!hasTry && ts.isTryStatement(n)) {
          hasTry = true;
        }
        if (!hasTry) {
          ts.forEachChild(n, look);
        }
      };
      look(body);
      let inside: Gap | undefined;
      for (let cur = hit.parent; cur && cur !== body; cur = cur.parent) {
        if (ts.isCatchClause(cur)) {
          inside = {
            line,
            what: `its catch clause ${verb === "throws" ? "rethrows" : `${verb} again`}: ${shown}`,
          };
          break;
        }
        if (ts.isTryStatement(cur) && !cur.catchClause) {
          inside = {
            line,
            what: `its try has no catch clause — ${shown} ${verb} through it`,
          };
          break;
        }
      }
      if (inside) {
        gap = inside;
      } else if (!ts.isBlock(body)) {
        gap = {
          line,
          what: `its expression body has no try/catch — ${shown} ${verb}`,
        };
      } else if (hasTry) {
        gap = { line, what: `${shown} ${verb} outside its try/catch` };
      } else {
        gap = { line, what: `its body has no try/catch — ${shown} ${verb}` };
      }
    }
    this.gaps.set(fn.node, gap);
    return gap;
  }

  /**
   * The first node inside `scope` that can reject and that no try/catch inside `scope`
   * protects: an `await`, a `for await`, a `yield`, a `throw`, a `return` of a call (a returned
   * promise), or a call of one of the adapter's own functions whose body has a gap. An awaited
   * or returned chain that carries its own `.catch(…)` cannot reject and does not count, nor
   * does an awaited or returned call of one of the adapter's own functions whose body has no
   * gap. A `try` with a catch clause protects its block — its catch and finally blocks are read,
   * a `try` without catch clause protects nothing. A nested function only runs when something
   * calls it and is not read.
   *
   * @param file the file of the scope
   * @param scope the body or statement to read
   * @returns the node, or undefined
   */
  private escapes(file: string, scope: TS.Node): TS.Node | undefined {
    const ts = this.ts;
    let found: TS.Node | undefined;
    const visit = (n: TS.Node): void => {
      if (found || (n !== scope && ts.isFunctionLike(n))) {
        return;
      }
      if (ts.isTryStatement(n) && n.catchClause) {
        visit(n.catchClause.block);
        if (n.finallyBlock) {
          visit(n.finallyBlock);
        }
        return;
      }
      if (
        (ts.isAwaitExpression(n) && this.rejects(file, n.expression, true)) ||
        ts.isYieldExpression(n) ||
        ts.isThrowStatement(n) ||
        (ts.isForOfStatement(n) && n.awaitModifier !== undefined) ||
        (ts.isReturnStatement(n) &&
          n.expression !== undefined &&
          returnsCall(ts, n.expression) &&
          this.rejects(file, n.expression, false)) ||
        (ts.isCallExpression(n) && this.ownCallThrows(file, n))
      ) {
        found = n;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return found;
  }

  /**
   * Whether an awaited or returned expression can reject: not when its chain carries a
   * `.catch(…)`, and not when it is a call of one of the adapter's own functions whose body has
   * no gap.
   *
   * @param file the file of the expression
   * @param expr the awaited or returned expression
   * @param awaited whether the expression is awaited (a returned call may not be a promise)
   * @returns true when a rejection can come out of it
   */
  rejects(file: string, expr: TS.Expression, awaited: boolean): boolean {
    const chain = readChain(this.ts, expr);
    if (chain.handled) {
      return false;
    }
    if (chain.root && chain.thenCallbacks.length > 0) {
      return this.chainRisk(file, chain) !== undefined;
    }
    return chain.root ? this.callRejects(file, chain.root, awaited) : awaited;
  }

  /**
   * What can reject in a dropped chain without a receiver: the call at its root when it is one
   * of the adapter's own functions with a gap (a root the check cannot resolve is not judged,
   * like a bare dropped call), or one of the `.then` callbacks — a callback the check cannot
   * resolve counts as one that can.
   *
   * @param file the file of the chain
   * @param chain the chain, with a root
   * @returns the words for the finding, or undefined when nothing in the chain can reject
   */
  chainRisk(file: string, chain: Chain): string | undefined {
    const source = this.sources.get(file) as TS.SourceFile;
    const root =
      chain.root && this.resolver.resolveFunction(file, chain.root.expression);
    if (chain.root && root && this.gap(root)) {
      const text = chain.root.expression.getText(source).replace(/\s+/g, "");
      return `a rejection of \`${text}(…)\``;
    }
    for (const callback of chain.thenCallbacks) {
      const fn = this.resolver.resolveFunction(file, callback);
      if (!fn) {
        return "a rejection of the then-callback";
      }
      const gap = this.gap(fn);
      if (gap) {
        return `a rejection of the then-callback (${gap.what})`;
      }
    }
    return undefined;
  }

  /**
   * Whether a plain call of one of the adapter's own sync functions throws through its body —
   * a helper that validates with `throw`, a sync function that awaits nothing but calls another
   * helper that throws. A call the check cannot resolve (a logger, a Map, `Object.keys`) is not
   * read: what it could throw is not the adapter's to guard, and a rule that counts every call
   * reports `this.log.debug(…)` before the try.
   *
   * @param file the file of the call
   * @param call the call
   * @returns true when the callee's body has a gap
   */
  private ownCallThrows(file: string, call: TS.CallExpression): boolean {
    const fn = this.resolver.resolveFunction(file, call.expression);
    // An async callee never throws into its caller — its rejection lives in the promise it
    // returns, which is judged where that promise is awaited, returned or dropped.
    return (
      fn !== undefined &&
      !isAsync(this.ts, fn.node) &&
      this.gap(fn) !== undefined
    );
  }

  /**
   * Whether an awaited or returned call can reject: `Promise.resolve(…)` and
   * `Promise.allSettled(…)` never do, one of the adapter's own functions does not when its
   * body has no gap, an awaited call of anything else can.
   *
   * @param file the file of the call
   * @param call the call
   * @param awaited whether the call is awaited
   * @returns true when a rejection can come out of it
   */
  private callRejects(
    file: string,
    call: TS.CallExpression,
    awaited: boolean,
  ): boolean {
    const source = this.sources.get(file) as TS.SourceFile;
    const callee = call.expression.getText(source).replace(/\s+/g, "");
    if (callee === "Promise.resolve" || callee === "Promise.allSettled") {
      return false;
    }
    const fn = this.resolver.resolveFunction(file, call.expression);
    if (!fn) {
      // An awaited call the check cannot resolve is a promise that can reject; a returned one
      // may as well be a plain value (`return String(err)`) and is not judged.
      return awaited;
    }
    return this.gap(fn) !== undefined;
  }
}

/**
 * Whether a returned expression is a call (a promise handed back unawaited), also behind
 * parentheses, `as`, `!` or a ternary.
 *
 * @param ts the TypeScript compiler API
 * @param expr the returned expression
 * @returns true for a returned call
 */
function returnsCall(ts: typeof TS, expr: TS.Expression): boolean {
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    return returnsCall(ts, expr.expression);
  }
  if (ts.isConditionalExpression(expr)) {
    return returnsCall(ts, expr.whenTrue) || returnsCall(ts, expr.whenFalse);
  }
  return ts.isCallExpression(expr);
}
