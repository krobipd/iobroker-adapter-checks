import { readFileSync } from "node:fs";
import type { Check, Finding } from "../types.js";
import { listSourceFiles, repoPath, stripTsComments } from "../util.js";

/** `process.on|once|addListener("uncaughtException" | "unhandledRejection", …)`. */
const PROCESS_HANDLER_RE =
  /\bprocess\s*\.\s*(?:on|once|addListener|prependListener)\s*\(\s*["'`](uncaughtException|unhandledRejection)["'`]/g;

/**
 * An adapter registers no process-wide error handler of its own.
 *
 * The adapter class of js-controller installs both handlers itself
 * (`packages/adapter/src/lib/adapter/adapter.ts`, `process.on('uncaughtException'|'unhandledRejection', …)`)
 * and routes them through its exception handler, which logs, reports and terminates the instance. A second
 * handler in the adapter runs beside it; in compact mode it also sees the errors of every other adapter in the
 * same process. Errors belong in a try/catch at the boundary where they happen.
 */
export const processHandlersCheck: Check = {
  id: "process-handlers",
  title:
    "no process-wide uncaughtException/unhandledRejection handler in the adapter",
  run(adapterDir: string): Finding[] {
    const findings: Finding[] = [];
    for (const file of listSourceFiles(adapterDir)) {
      let source: string;
      try {
        source = stripTsComments(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      for (const match of source.matchAll(PROCESS_HANDLER_RE)) {
        findings.push({
          check: processHandlersCheck.id,
          file: repoPath(adapterDir, file),
          line: source.slice(0, match.index ?? 0).split("\n").length,
          message: `process-wide \`${match[1]}\` handler — js-controller already owns it (adapter.ts)`,
          impact:
            "it runs beside the controller's handler and, in compact mode, catches other adapters' errors",
        });
      }
    }
    return findings;
  },
};
