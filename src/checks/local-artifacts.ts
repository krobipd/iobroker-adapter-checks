import { statSync } from "node:fs";
import { join } from "node:path";
import type { Check, Finding } from "../types.js";
import { readText } from "../util.js";

/** A directory or file the local toolchain creates in the repository root. */
interface Artifact {
  /** Its name in the repository root. */
  path: string;
  /** What ends up in the repository when nothing ignores it. */
  impact: string;
}

/**
 * Artifacts that appear in the root while working and must never be committed. Anything
 * a repository may legitimately track is deliberately absent: `build/` is committed by
 * some adapters on purpose, and so are generated admin bundles.
 */
const ARTIFACTS: readonly Artifact[] = [
  {
    path: "node_modules",
    impact: "a broad `git add` commits the whole dependency tree",
  },
  {
    path: ".dev-server",
    impact:
      "a broad `git add` commits the throwaway ioBroker profile, developer hostname included",
  },
  {
    path: "coverage",
    impact: "a broad `git add` commits the generated coverage report",
  },
  {
    path: ".env",
    impact: "a broad `git add` commits local credentials",
  },
];

/**
 * Translate one .gitignore path segment into a regular expression.
 *
 * Only the wildcards that appear in real adapter ignore files are honoured: `*` for any
 * run of characters inside a segment and `?` for a single one. Everything else is taken
 * literally — a bracket expression therefore does not match, which can only make this
 * check quieter, never louder.
 *
 * @param segment the pattern, already stripped of anchors and the directory marker
 * @returns a regular expression anchored to the whole segment
 */
function segmentToRegExp(segment: string): RegExp {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Does .gitignore keep one root-level entry out of the repository?
 *
 * Follows git's own rules for the case at hand: comments and blank lines are skipped,
 * `!` re-includes, a trailing `/` restricts a pattern to directories, and the last
 * matching pattern decides. A pattern that still spans directories after the anchors are
 * removed cannot describe a name in the root and is passed over — `.claude/dev-history.md`
 * says nothing about `.dev-server`.
 *
 * @param gitignore the file's contents, empty when there is none
 * @param name the root-level entry, e.g. ".dev-server"
 * @param isDir whether that entry is a directory
 * @returns true when git would leave it untracked
 */
function isIgnored(gitignore: string, name: string, isDir: boolean): boolean {
  let ignored = false;
  for (const raw of gitignore.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    let pattern = line;
    const negated = pattern.startsWith("!");
    if (negated) {
      pattern = pattern.slice(1);
    }
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) {
      pattern = pattern.slice(0, -1);
    }
    if (pattern.startsWith("/")) {
      pattern = pattern.slice(1);
    }
    if (pattern.startsWith("**/")) {
      pattern = pattern.slice(3);
    }
    if (pattern === "" || pattern.includes("/")) {
      continue;
    }
    if (dirOnly && !isDir) {
      continue;
    }
    if (segmentToRegExp(pattern).test(name)) {
      ignored = !negated;
    }
  }
  return ignored;
}

/**
 * Local artifacts in the repository root belong in .gitignore.
 *
 * The release tooling and every "commit everything" habit stage whatever git does not
 * ignore, so a single missing line is enough to publish a working directory into a public
 * repository. That is not hypothetical: the throwaway dev-server profile of one adapter
 * reached its public repo this way, hostname included, because that one .gitignore lacked
 * the entry the other ten repositories had.
 *
 * The check reports an artifact only once it actually exists, so a repository that never
 * runs the tool that creates it is never asked to ignore it. It cannot see whether an
 * artifact is already tracked — git ignores nothing that is — but the missing rule is the
 * cause, and it is visible before the first commit.
 */
export const localArtifactsCheck: Check = {
  id: "local-artifacts",
  title: "local artifacts in the repository root are ignored",
  run(adapterDir: string): Finding[] {
    const gitignore = readText(adapterDir, ".gitignore") ?? "";
    const findings: Finding[] = [];
    for (const artifact of ARTIFACTS) {
      const stat = statSync(join(adapterDir, artifact.path), {
        throwIfNoEntry: false,
      });
      if (!stat) {
        continue;
      }
      if (isIgnored(gitignore, artifact.path, stat.isDirectory())) {
        continue;
      }
      findings.push({
        check: localArtifactsCheck.id,
        file: ".gitignore",
        message: `"${artifact.path}" exists in the repository root, and no rule in .gitignore covers it`,
        impact: artifact.impact,
      });
    }
    return findings;
  },
};
