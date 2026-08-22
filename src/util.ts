import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * All adapter TypeScript sources below `src/`, excluding tests and type declarations —
 * the same set the python original scanned (`src/**\/*.ts` minus `.test.ts` / `.d.ts`).
 *
 * @param adapterDir the adapter repository root
 * @returns absolute file paths, sorted, empty when there is no `src/`
 */
export function listSourceFiles(adapterDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (name !== "node_modules") {
          walk(full);
        }
      } else if (
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts") &&
        !name.endsWith(".d.ts")
      ) {
        out.push(full);
      }
    }
  };
  walk(join(adapterDir, "src"));
  return out;
}

/**
 * Read and parse a JSON file below the adapter.
 *
 * @param adapterDir the adapter repository root
 * @param relPath path relative to it, e.g. "io-package.json"
 * @returns the parsed value, or undefined when the file is missing or unparseable
 */
export function readJson<T = unknown>(
  adapterDir: string,
  relPath: string,
): T | undefined {
  try {
    return JSON.parse(readFileSync(join(adapterDir, relPath), "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Read a text file below the adapter.
 *
 * @param adapterDir the adapter repository root
 * @param relPath path relative to it
 * @returns the text, or undefined when the file is missing
 */
export function readText(
  adapterDir: string,
  relPath: string,
): string | undefined {
  try {
    return readFileSync(join(adapterDir, relPath), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Path of a file relative to the adapter root, always with forward slashes.
 *
 * Windows would otherwise report `src\\main.ts` where Linux reports `src/main.ts`; a
 * finding has to read the same everywhere, and tests must not depend on the platform.
 *
 * @param adapterDir the adapter repository root
 * @param file absolute path of the file
 * @returns the relative path with forward slashes
 */
export function repoPath(adapterDir: string, file: string): string {
  return relative(adapterDir, file).split(sep).join("/");
}
