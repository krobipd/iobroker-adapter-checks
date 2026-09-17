import type TS from "typescript";
import { typescriptApi } from "../adapter-api.js";
import {
  FunctionResolver,
  functionWithBody,
  parseSources,
} from "../sources.js";
import type { Check, Finding } from "../types.js";
import { listSourceFiles, repoPath } from "../util.js";

/** One function that carries the object branch of the error-text helper. */
interface Helper {
  file: string;
  line: number;
  name: string;
}

/**
 * The helper that turns a thrown value into text exists once per repository — an Admin
 * component imports it, it does not carry a copy.
 *
 * The helper's object branch is the part that is easy to get wrong and therefore the part that
 * gets copied: `JSON.stringify(value)` for the readable form, guarded by try/catch because a
 * circular structure throws, with `Object.prototype.toString.call(value)` as the fallback for
 * what `JSON.stringify` cannot render (`caught-value-text` describes why). A second function
 * with that branch — typically in `src-admin/src/` next to the adapter's own in `src/lib/` —
 * is a copy, and a copy drifts: govee-smart 2.38.2 carried one in the admin component because
 * of a build limitation that had been disproved for two weeks; homeconnect 1.21.0 carries one
 * that explains itself with a declaration file the module-federation plugin writes next to the
 * source (`dts: false` stops that). The rule is one helper, imported wherever a caught value
 * becomes text.
 *
 * Judged with the TypeScript compiler of the adapter: every function (declaration, method,
 * arrow or function expression) below `src/` and `src-admin/src/` whose body calls both
 * `JSON.stringify(…)` and `Object.prototype.toString.call(…)` is a helper; the first one under
 * `src/` is the repository's, every further one is reported. Without a loadable `typescript`
 * the check reports that instead of staying silent.
 */
export const errorTextHelperCheck: Check = {
  id: "error-text-helper",
  title:
    "the error-text helper exists once per repository — the Admin component imports it, it does not carry a copy",
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
          check: errorTextHelperCheck.id,
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
    const helpers: Helper[] = [];
    for (const [file, source] of sources) {
      const candidates: TS.FunctionLikeDeclaration[] = [];
      const visit = (node: TS.Node): void => {
        const fn = functionWithBody(ts, node);
        if (fn && carriesObjectBranch(ts, source, fn.body)) {
          candidates.push(fn);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      // The innermost function is the helper — a component that defines it inline carries the
      // branch too, but only through the function it defines.
      for (const fn of candidates) {
        const inner = candidates.some(
          (c) => c !== fn && c.pos >= fn.pos && c.end <= fn.end,
        );
        if (inner) {
          continue;
        }
        helpers.push({
          file: repoPath(adapterDir, file),
          line:
            source.getLineAndCharacterOfPosition(fn.getStart(source)).line + 1,
          name: resolver.functionName(fn),
        });
      }
    }
    // The adapter's own helper comes first: `src/` before `src-admin/`, then by path and line.
    helpers.sort(
      (a, b) =>
        Number(a.file.startsWith("src-admin/")) -
          Number(b.file.startsWith("src-admin/")) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line,
    );
    const [first, ...copies] = helpers;
    if (!first) {
      return [];
    }
    return copies.map((copy) => ({
      check: errorTextHelperCheck.id,
      file: copy.file,
      line: copy.line,
      message: `${copy.name} is a second error-text helper — the repository's is ${first.name} in ${first.file}:${first.line}`,
      impact:
        "a copy drifts from the helper it was taken from, and a Sentry event or log line then reads differently depending on which side rendered it; the Admin component imports the adapter's helper from `src/` (with `dts: false` in the module-federation plugin the build writes no declaration next to the source), and one function carries the rule",
    }));
  },
};

/**
 * Whether a function body calls both `JSON.stringify(…)` and `Object.prototype.toString.call(…)`
 * — the object branch of the error-text helper, in whichever shape it is written.
 *
 * @param ts the TypeScript compiler API
 * @param source the file
 * @param body the function body
 * @returns true for a helper body
 */
function carriesObjectBranch(
  ts: typeof TS,
  source: TS.SourceFile,
  body: TS.Node,
): boolean {
  let stringify = false;
  let tag = false;
  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source).replace(/\s+/g, "");
      if (callee === "JSON.stringify") {
        stringify = true;
      } else if (callee === "Object.prototype.toString.call") {
        tag = true;
      }
    }
    if (!(stringify && tag)) {
      ts.forEachChild(node, visit);
    }
  };
  visit(body);
  return stringify && tag;
}
