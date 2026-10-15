import { readFileSync } from "node:fs";
import type { Check, Finding } from "../types.js";
import { listSourceFiles, repoPath, stripTsComments } from "../util.js";

/** `this.on("<event>", <handler>)` — the handler argument up to the closing parenthesis of the call. */
const REGISTRATION_RE = /\bthis\s*\.\s*on\s*\(\s*["'`](\w+)["'`]\s*,\s*/g;

/**
 * Index of the brace that closes the block opened at `open`.
 *
 * @param source the source text
 * @param open index of an opening brace
 * @returns index of the matching closing brace, or -1
 */
function blockEnd(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Whether every statement in `text` hands its rejection to an own `.catch(…)` — the only statements allowed
 * outside the top-level `try` (`await I18n.init(…).catch(…)`, ioBroker.shelly).
 *
 * @param text statements outside the try
 * @returns true when the text is empty or each statement carries `.catch(`
 */
function onlyCaughtStatements(text: string): boolean {
  return text
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .every((s) => /\.catch\s*\(/.test(s));
}

/**
 * Whether a function body is one top-level `try` with its `catch`/`finally`; around it only statements that
 * catch their own rejection.
 *
 * @param body the text between the body braces
 * @returns true when the whole body is guarded
 */
function wholeBodyInTry(body: string): boolean {
  const at = body.search(/(?:^|[;}\s])try\s*\{/);
  if (at < 0) {
    return false;
  }
  const start = body.indexOf("try", at);
  if (!onlyCaughtStatements(body.slice(0, start))) {
    return false;
  }
  let end = blockEnd(body, body.indexOf("{", start));
  for (;;) {
    if (end < 0) {
      return false;
    }
    const rest = body.slice(end + 1);
    const next = /^\s*(catch\s*(?:\([^)]*\))?\s*\{|finally\s*\{)/.exec(rest);
    if (!next) {
      return onlyCaughtStatements(rest);
    }
    const open = end + 1 + next[0].length - 1;
    end = blockEnd(body, open);
  }
}

/**
 * Async lifecycle handlers are bound and guarded as a whole.
 *
 * `this.on("ready" | "stateChange" | "message" | …, handler)` registers a listener whose returned promise
 * nobody awaits: a rejection becomes an unhandled rejection, which js-controller turns into a crash and a
 * restart loop. The ioBroker review form (mcm1957, PR #654) is `this.on("x", this.onX.bind(this))` and the
 * whole body of an async handler inside one top-level `try`.
 */
export const handlerGuardCheck: Check = {
  id: "handler-guard",
  title:
    "lifecycle handlers are bound and an async handler's whole body sits in one try",
  run(adapterDir: string): Finding[] {
    const findings: Finding[] = [];
    for (const file of listSourceFiles(adapterDir)) {
      let source: string;
      try {
        source = stripTsComments(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const report = (index: number, event: string, message: string): void => {
        findings.push({
          check: handlerGuardCheck.id,
          file: repoPath(adapterDir, file),
          line: source.slice(0, index).split("\n").length,
          message: `"${event}" handler ${message}`,
          impact:
            "a rejection escapes to the process — js-controller restarts the instance",
        });
      };
      for (const match of source.matchAll(REGISTRATION_RE)) {
        const at = match.index ?? 0;
        const event = match[1] ?? "";
        const rest = source.slice(at + match[0].length);
        const inline =
          /^async\s*(?:\((?:[^()]|\([^()]*\))*\)|[\w$]+)\s*=>\s*\{/.exec(rest);
        if (inline) {
          const open = at + match[0].length + inline[0].length - 1;
          const close = blockEnd(source, open);
          if (!wholeBodyInTry(source.slice(open + 1, close))) {
            report(at, event, "has code outside one top-level `try`");
          }
          continue;
        }
        const member =
          /^this\s*\.\s*([\w$]+)(\s*\.\s*bind\s*\(\s*this\s*\))?/.exec(rest);
        if (!member) {
          continue;
        }
        const name = member[1] ?? "";
        // An arrow-function property (`onReady = async () => { … }`, ioBroker.shelly) carries `this` by itself.
        const arrowProperty = new RegExp(
          `(?:^|[\\s;}])(?:(?:private|public|protected|readonly|override)\\s+)*${name}\\s*(?::[^=]+)?=\\s*(async\\s+)?(?:\\((?:[^()]|\\([^()]*\\))*\\)|[\\w$]+)\\s*(?::[^=]+)?=>\\s*(\\{)?`,
          "m",
        ).exec(source);
        if (arrowProperty) {
          // An expression body (`=> this.x(…)`) has no statement that could sit outside a try.
          if (arrowProperty[1] && arrowProperty[2]) {
            const open =
              (arrowProperty.index ?? 0) + arrowProperty[0].length - 1;
            if (
              !wholeBodyInTry(source.slice(open + 1, blockEnd(source, open)))
            ) {
              report(at, event, "has code outside one top-level `try`");
            }
          }
          continue;
        }
        if (!member[2]) {
          report(at, event, "is registered without `.bind(this)`");
          continue;
        }
        const definition = new RegExp(
          `(?:^|[\\s;}])(?:(?:private|public|protected|static|override)\\s+)*(async\\s+)?${name}\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*(?::[^{]+)?\\{`,
          "m",
        ).exec(source);
        if (!definition || !definition[1]) {
          continue;
        }
        const open = (definition.index ?? 0) + definition[0].length - 1;
        const close = blockEnd(source, open);
        if (!wholeBodyInTry(source.slice(open + 1, close))) {
          report(at, event, "has code outside one top-level `try`");
        }
      }
    }
    return findings;
  },
};
