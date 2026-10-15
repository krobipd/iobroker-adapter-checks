import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Check, Finding } from "../types.js";
import { repoPath } from "../util.js";

/** Folders that are not the adapter's own files. */
const SKIPPED = new Set([
  "node_modules",
  ".git",
  ".dev-server",
  "build",
  "coverage",
]);

/**
 * An ioBroker adapter repository carries no Python.
 *
 * The build and release environment of an adapter is npm and JSON only — the release script runs npm steps,
 * the CI runs Node (ioBroker community review, mcm1957 on fakeroku#254 and yamaha#609). A Python helper is
 * a second toolchain nobody else can run.
 */
export const noPythonCheck: Check = {
  id: "no-python",
  title: "the repository carries no Python files",
  run(adapterDir: string): Finding[] {
    const findings: Finding[] = [];
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const name of entries) {
        if (SKIPPED.has(name)) {
          continue;
        }
        const full = join(dir, name);
        let isDir: boolean;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          walk(full);
        } else if (name.endsWith(".py")) {
          findings.push({
            check: noPythonCheck.id,
            file: repoPath(adapterDir, full),
            message:
              "Python file in the adapter repository — the build and release environment is npm only",
          });
        }
      }
    };
    walk(adapterDir);
    return findings;
  },
};
