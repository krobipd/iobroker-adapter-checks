import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Check, Finding } from "../types.js";
import { repoPath } from "../util.js";

/** The files the repository checker reads as code (lib/M5000_Code.js `executableExtensions`). */
const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts"]);

/** Folders skipped at any depth — never read, or skipped by the scan at every level. */
const SKIPPED_ANYWHERE = new Set([
  "node_modules",
  "admin",
  "admin-src",
  "doc",
  "docs",
  ".dev-server",
  ".git",
  ".vscode",
  "tmp",
]);

/** Folders skipped only at the repository root (`excludedSourceDirs` with a leading slash). */
const SKIPPED_AT_ROOT = new Set([
  "build",
  "example",
  "examples",
  "scripts",
  "template",
  "templates",
  "test",
  "tools",
  "src-admin",
  "src-devices",
  "src-editor",
  "src-rules",
  "src-tab",
  "src-vis",
  "src-widgets",
  "src-www",
  "rules-src",
  "www",
  "widgets",
  "hass_frontend",
]);

/** Build scripts by name (`excludedSourceFiles`). */
const SKIPPED_NAMES = new Set([
  "tasks.js",
  "tasks.mjs",
  "tasks.cjs",
  "tasks.ts",
  "Gruntfile.js",
  "gulpfile.js",
]);

const TOOLS = ["lib/tools.js", "lib/tools.mjs", "lib/tools.cjs"];

/**
 * The comments removed the way the repository checker removes them (`stripComments`): block comments, then line comments.
 *
 * @param text source text
 * @returns the text without comments
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Every code file the checker reads, relative to the repository, with its text.
 *
 * @param adapterDir repository root
 * @returns relative path → text
 */
function codeFiles(adapterDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!SKIPPED_ANYWHERE.has(name)) {
          walk(full, relPath);
        }
      } else if (CODE_EXTENSIONS.has(extname(name))) {
        try {
          out.set(relPath, readFileSync(full, "utf8"));
        } catch {
          continue;
        }
      }
    }
  };
  walk(adapterDir, "");
  return out;
}

/**
 * Does the repository checker scan this file for dependencies and `process.env` (lib/M5000_Code.js)?
 *
 * @param rel path relative to the repository
 * @param files every code file the checker reads
 * @returns true when the file is scanned
 */
function scanned(rel: string, files: Map<string, string>): boolean {
  const parts = rel.split("/");
  if (parts.length > 1 && SKIPPED_AT_ROOT.has(parts[0] ?? "")) {
    return false;
  }
  const name = basename(rel);
  if (
    SKIPPED_NAMES.has(name) ||
    name.includes(".test.") ||
    name.includes(".config.")
  ) {
    return false;
  }
  if (
    parts.length === 1 &&
    /^tasks.+\.(js|mjs|cjs|ts)$/.test(name) &&
    (files.get(rel) ?? "").includes("@iobroker/build-tools")
  ) {
    return false;
  }
  if (TOOLS.includes(rel)) {
    // lib/tools.* is skipped unless another file of the repository requires it
    return [...files].some(
      ([other, text]) =>
        other !== rel &&
        [
          "lib/tools",
          "./lib/tools",
          "../lib/tools",
          "./tools",
          "../tools",
        ].some((ref) => text.includes(ref)),
    );
  }
  return true;
}

/**
 * The adapter's code reads no `process.env`.
 *
 * The repository checker reports every `process.env` in the adapter's code (lib/M5000_Code.js, E5049; W5049 with
 * `common.compact: false`): in compact mode the adapters of a host share one process, and the checker asks for the
 * instance configuration instead. Both block the release. Same files as the checker — tests, `test/`, `build/` and the
 * admin sources stay out, where a test harness sets `NODE_OPTIONS` legitimately. Found by homeconnect 2026-10-21: an
 * inventory hook widened the adapter's pace through a variable its source read, and the checker caught it only at the
 * end of the release run.
 */
export const processEnvCheck: Check = {
  id: "process-env",
  title: "the adapter's code reads no process.env",
  run(adapterDir: string): Finding[] {
    const files = codeFiles(adapterDir);
    const findings: Finding[] = [];
    for (const [rel, text] of files) {
      if (
        !scanned(rel, files) ||
        !/\bprocess\.env\b/.test(withoutComments(text))
      ) {
        continue;
      }
      findings.push({
        check: processEnvCheck.id,
        file: repoPath(adapterDir, join(adapterDir, rel)),
        message:
          "process.env in the adapter's code — the repository checker reports E5049 (W5049 without compact mode)",
        impact:
          "in compact mode the adapters of a host share one process; a value belongs in the instance configuration",
      });
    }
    return findings;
  },
};
