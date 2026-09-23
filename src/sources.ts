import { dirname, join } from "node:path";
import type TS from "typescript";
import { readText, repoPath } from "./util.js";

/** The parsed sources of one adapter, by absolute path. */
export type Sources = Map<string, TS.SourceFile>;

/** A function and the file that declares it. */
export interface ResolvedFunction {
  /** The absolute path of the file that declares the function. */
  file: string;
  /** The function. */
  node: TS.FunctionLikeDeclaration;
}

/**
 * Parse adapter sources with the adapter's own compiler — TSX for `.tsx`, TS otherwise.
 *
 * @param ts the TypeScript compiler API
 * @param adapterDir the adapter repository root
 * @param files absolute paths of the sources to parse
 * @returns the syntax trees by absolute path, in the order given
 */
export function parseSources(
  ts: typeof TS,
  adapterDir: string,
  files: readonly string[],
): Sources {
  const sources: Sources = new Map();
  for (const file of files) {
    const text = readText(adapterDir, repoPath(adapterDir, file)) ?? "";
    sources.set(
      file,
      ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
    );
  }
  return sources;
}

/**
 * A function with a body — declaration, method, accessor, arrow or function expression — as
 * opposed to a signature (an interface member, an overload, an abstract method).
 *
 * @param ts the TypeScript compiler API
 * @param node any node
 * @returns the node as a function-like declaration when it carries a body, else undefined
 */
export function functionWithBody(
  ts: typeof TS,
  node: TS.Node,
): (TS.FunctionLikeDeclaration & { body: TS.ConciseBody }) | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)) &&
    node.body
  ) {
    return node as TS.FunctionLikeDeclaration & { body: TS.ConciseBody };
  }
  return undefined;
}

/**
 * Finds the function an expression names, across the parsed sources of one adapter: an
 * arrow/function expression as written, an identifier declared in the same file or imported
 * from a relative module, `this.method` of the enclosing class — each also wrapped in
 * `.bind(…)`. Shared by the checks that follow a value or a call into the function behind it.
 */
export class FunctionResolver {
  /**
   * @param ts the TypeScript compiler API
   * @param sources the parsed sources of the adapter
   */
  constructor(
    private readonly ts: typeof TS,
    private readonly sources: Sources,
  ) {}

  /**
   * The function an expression names.
   *
   * @param file the file of the expression
   * @param expr the expression
   * @returns the function and its file, or undefined when it is not a local function
   */
  resolveFunction(
    file: string,
    expr: TS.Expression,
  ): ResolvedFunction | undefined {
    const ts = this.ts;
    while (ts.isParenthesizedExpression(expr)) {
      expr = expr.expression;
    }
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
      return { file, node: expr };
    }
    if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === "bind"
    ) {
      return this.resolveFunction(file, expr.expression.expression);
    }
    if (ts.isIdentifier(expr)) {
      const local = this.declaredFunction(
        this.sources.get(file) as TS.SourceFile,
        expr.text,
      );
      if (local) {
        return { file, node: local };
      }
      return this.importedFunction(file, expr.text);
    }
    if (
      ts.isPropertyAccessExpression(expr) &&
      expr.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      for (let cur: TS.Node | undefined = expr.parent; cur; cur = cur.parent) {
        if (ts.isClassLike(cur)) {
          const member = this.classMember(cur, expr.name.text);
          return member ? { file, node: member } : undefined;
        }
      }
    }
    return undefined;
  }

  /**
   * A method or arrow-property of a class by name.
   *
   * @param cls the class
   * @param name the member name
   * @returns the function, or undefined
   */
  classMember(
    cls: TS.ClassLikeDeclaration,
    name: string,
  ): TS.FunctionLikeDeclaration | undefined {
    const ts = this.ts;
    for (const m of cls.members) {
      if (!m.name || !ts.isIdentifier(m.name) || m.name.text !== name) {
        continue;
      }
      if (ts.isMethodDeclaration(m)) {
        return m;
      }
      if (
        ts.isPropertyDeclaration(m) &&
        m.initializer &&
        (ts.isArrowFunction(m.initializer) ||
          ts.isFunctionExpression(m.initializer))
      ) {
        return m.initializer;
      }
    }
    return undefined;
  }

  /**
   * A function declared anywhere in a file under that name: `function name`, or
   * `const name = (…) => …` / `= function …`.
   *
   * @param source the file
   * @param name the name
   * @returns the function, or undefined
   */
  declaredFunction(
    source: TS.SourceFile,
    name: string,
  ): TS.FunctionLikeDeclaration | undefined {
    const ts = this.ts;
    let found: TS.FunctionLikeDeclaration | undefined;
    const visit = (node: TS.Node): void => {
      if (found) {
        return;
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
        found = node;
        return;
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      ) {
        found = node.initializer;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  /**
   * A function imported by name from a relative module of the adapter.
   *
   * @param file the importing file
   * @param name the local name
   * @returns the function and its file, or undefined
   */
  importedFunction(file: string, name: string): ResolvedFunction | undefined {
    const ts = this.ts;
    const source = this.sources.get(file) as TS.SourceFile;
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) {
        continue;
      }
      for (const element of bindings.elements) {
        if (element.name.text !== name) {
          continue;
        }
        const exported = element.propertyName?.text ?? name;
        const target = this.resolveModule(file, statement.moduleSpecifier.text);
        if (!target) {
          return undefined;
        }
        const node = this.declaredFunction(
          this.sources.get(target) as TS.SourceFile,
          exported,
        );
        return node ? { file: target, node } : undefined;
      }
    }
    return undefined;
  }

  /**
   * The source file a relative import names — `./x.js` → `x.ts`, `./dir` → `dir/index.ts`.
   *
   * @param from the importing file
   * @param specifier the module text
   * @returns the absolute path of a parsed source, or undefined
   */
  resolveModule(from: string, specifier: string): string | undefined {
    if (!specifier.startsWith(".")) {
      return undefined;
    }
    // join, not resolve: the sources are keyed by the walker's paths, which stay relative when
    // the adapter directory was given relative — resolve() made every relative import miss.
    const base = join(dirname(from), specifier);
    const candidates = [
      base.replace(/\.(m|c)?js$/, ".ts"),
      base.replace(/\.(m|c)?js$/, ".$1ts"),
      `${base}.ts`,
      `${base}/index.ts`,
    ];
    for (const c of candidates) {
      if (this.sources.has(c)) {
        return c;
      }
    }
    return undefined;
  }

  /**
   * A readable name for a function, for the finding.
   *
   * @param fn the function
   * @returns "`errText`", "`onError`" or "an arrow function"
   */
  functionName(fn: TS.FunctionLikeDeclaration): string {
    const ts = this.ts;
    if (fn.name && ts.isIdentifier(fn.name)) {
      return `\`${fn.name.text}\``;
    }
    const p = fn.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
      return `\`${p.name.text}\``;
    }
    if (p && ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) {
      return `\`${p.name.text}\``;
    }
    return "an arrow function";
  }
}
