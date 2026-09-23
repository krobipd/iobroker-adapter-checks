import type TS from "typescript";
import { typescriptApi } from "../adapter-api.js";
import { parseSources } from "../sources.js";
import type { Check, Finding } from "../types.js";
import { listSourceFiles, repoPath } from "../util.js";
import { errorTextHelpers } from "./error-text-helper.js";

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

const ADVICE =
  "for an Error the helper returns its message (its string `code` when the message is empty) and, one level deep, the text of its `cause` (an Error's message or code, any other value through the helper's own branches), unless the message already contains it: `fetch failed (getaddrinfo ENOTFOUND host)`";

/**
 * The repository's error-text helper renders an Error with its reason: the message, the `code`
 * when the message is empty, and one level of `cause`.
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
 */
export const errorTextReasonCheck: Check = {
  id: "error-text-reason",
  title:
    "the error-text helper renders an Error with its reason — the `code` when the message is empty, one level of `cause`",
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
    return PARTS.filter((part) => !read.has(part.property)).map((part) => ({
      check: errorTextReasonCheck.id,
      file: helper.file,
      line: helper.line,
      message: `the error-text helper ${helper.name} ${part.message}`,
      impact: ADVICE,
    }));
  },
};

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
