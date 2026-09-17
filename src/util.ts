import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * All adapter TypeScript sources below `src/`, excluding tests and type declarations —
 * the same set the python original scanned (`src/**\/*.ts` minus `.test.ts` / `.d.ts`).
 * With `admin: true` the sources of an Admin 8 custom component below `src-admin/src/` come
 * too, `.tsx` included — a settings dialog catches and logs errors like the adapter does.
 *
 * @param adapterDir the adapter repository root
 * @param options what to include beyond `src/`
 * @param options.admin also list `src-admin/src/**\/*.ts` and `*.tsx`
 * @returns absolute file paths, sorted per root, empty when there is no `src/`
 */
export function listSourceFiles(
  adapterDir: string,
  options: { admin?: boolean } = {},
): string[] {
  const out: string[] = [];
  const walk = (dir: string, keep: (name: string) => boolean): void => {
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
          walk(full, keep);
        }
      } else if (keep(name)) {
        out.push(full);
      }
    }
  };
  walk(
    join(adapterDir, "src"),
    (name) =>
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts"),
  );
  if (options.admin) {
    walk(
      join(adapterDir, "src-admin", "src"),
      (name) =>
        /\.tsx?$/.test(name) &&
        !/\.test\.tsx?$/.test(name) &&
        !name.endsWith(".d.ts"),
    );
  }
  return out;
}

const TEST_EXTENSIONS = [".ts", ".js", ".cjs", ".mjs", ".tsx"];

/**
 * All test sources of an adapter: `src/**\/*.test.ts` plus every script below `test/` (unit
 * tests, integration harness, inventory fixtures such as a `--require` fetch hook), excluding
 * `node_modules` and type declarations.
 *
 * @param adapterDir the adapter repository root
 * @returns absolute file paths, sorted
 */
export function listTestFiles(adapterDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, keep: (name: string) => boolean): void => {
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
          walk(full, keep);
        }
      } else if (keep(name)) {
        out.push(full);
      }
    }
  };
  walk(join(adapterDir, "src"), (name) => name.endsWith(".test.ts"));
  walk(
    join(adapterDir, "test"),
    (name) =>
      TEST_EXTENSIONS.some((ext) => name.endsWith(ext)) &&
      !name.endsWith(".d.ts"),
  );
  return out.sort();
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

/**
 * A YAML text as lines with comments removed — comment lines become empty, a trailing
 * comment (a `#` preceded by whitespace) is cut. Line count and numbering stay intact, so a
 * finding can still point at the original line.
 *
 * A commented-out condition, job or trigger must never count as one; every workflow-reading
 * check runs on these lines.
 *
 * @param text the YAML text
 * @returns the lines, comments removed
 */
export function stripYamlComments(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => (/^\s*#/.test(l) ? "" : l.replace(/\s+#.*$/, "")));
}

/**
 * A TypeScript text with comments removed — block comments (`/* … *\/`) and line comments
 * (`// …`) — while every newline stays where it was, so a finding can still point at the
 * original line.
 *
 * Checks that read what an adapter DOES rather than what it says about itself run on this
 * text: the very pattern a check looks for tends to sit in the explanation above the code
 * ("the earlier guard tested `?.stopInstance`"), and a check that reports its own
 * documentation gets switched off instead of read. Strings are left alone — a `//` inside a
 * URL literal cuts the rest of that line, which touches none of the patterns searched here.
 *
 * @param text the TypeScript source
 * @returns the source without comments, same line count
 */
export function stripTsComments(text: string): string {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, ""),
  );
  return withoutBlocks.replace(/\/\/[^\n]*/g, "");
}
