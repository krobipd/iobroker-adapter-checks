import type { Check, Finding } from "../types.js";
import { readJson } from "../util.js";

type Version = [number, number, number];

/**
 * `major.minor.patch` of a version or a partial one (`9`, `9.1`, `v9.1.0-beta.1`); undefined when it is none.
 *
 * @param text the version text
 * @returns the three numbers, missing parts as 0
 */
function parseVersion(text: string): Version | undefined {
  const m = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+].*)?$/.exec(
    text.trim(),
  );
  if (!m) {
    return undefined;
  }
  const part = (s: string | undefined): number =>
    s === undefined || /^[xX*]$/.test(s) ? 0 : Number(s);
  return [part(m[1]), part(m[2]), part(m[3])];
}

/**
 * Compares two versions.
 *
 * @param a first version
 * @param b second version
 * @returns negative, zero or positive
 */
function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The lowest version a semver range admits: the lowest lower bound over its `||` alternatives, each alternative
 * bounded by its highest `^`/`~`/`>=`/`>`/`=`/bare comparator (an upper bound alone admits 0.0.0). Undefined for a
 * range that is not a version range (`npm:`, `file:`, a git or tarball URL, a dist tag) — nothing to judge.
 *
 * @param range the declared range
 * @returns the lowest admitted version, or undefined
 */
export function lowestAdmitted(range: string): Version | undefined {
  if (/[:/]/.test(range)) {
    return undefined;
  }
  let lowest: Version | undefined;
  for (const alternative of range.split("||")) {
    // `1.2.3 - 2.3.4`: the part after the hyphen is an upper bound.
    const text = alternative.trim().replace(/\s+-\s+/, " <=");
    let bound: Version = [0, 0, 0];
    for (const token of text.split(/\s+/).filter(Boolean)) {
      if (token === "*" || /^[xX]$/.test(token) || token.startsWith("<")) {
        continue;
      }
      const version = parseVersion(token.replace(/^(\^|~|>=|>|=)/, ""));
      if (!version) {
        return undefined;
      }
      if (compare(version, bound) > 0) {
        bound = version;
      }
    }
    if (!lowest || compare(bound, lowest) < 0) {
      lowest = bound;
    }
  }
  return lowest;
}

/**
 * Every package name `overrides` touches, at any depth (`{ "mocha": { "diff": "^8.0.3" } }` names mocha and diff).
 *
 * @param overrides the `overrides` block of package.json
 * @returns the names
 */
function overriddenNames(overrides: unknown): Set<string> {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) {
      return;
    }
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      if (key !== ".") {
        // `name@range` keys select by version; the package is the part before the last `@`.
        const at = key.lastIndexOf("@");
        names.add(at > 0 ? key.slice(0, at) : key);
      }
      walk(value);
    }
  };
  walk(overrides);
  return names;
}

/** One entry of `packages` in a lockfile v2/v3. */
interface LockEntry {
  version?: unknown;
  dependencies?: unknown;
  optionalDependencies?: unknown;
}

/**
 * The lock key of the instance of `name` a package at `from` loads: its own `node_modules` first, then each
 * enclosing one up to the root — node's resolution, as npm writes it into the lock.
 *
 * @param packages the lock's `packages`
 * @param from the lock key of the dependant
 * @param name the dependency's name
 * @returns the key, or undefined when none is installed
 */
function resolveInstalled(
  packages: Record<string, LockEntry>,
  from: string,
  name: string,
): string | undefined {
  let base = from;
  for (;;) {
    const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[key]) {
      return key;
    }
    if (!base) {
      return undefined;
    }
    const cut = base.lastIndexOf("node_modules/");
    base = cut <= 0 ? "" : base.slice(0, cut - 1);
  }
}

/**
 * An `overrides` entry never puts a dependency BELOW the lowest version its dependant declares.
 *
 * npm's `overrides` (package.json, npm ≥ 8.3) replace a package anywhere in the tree with the given version — also with
 * one the dependant does not admit. A security override is written against the dependant of its day (the fleet's
 * `"mocha": { "diff": "^8.0.3" }` against mocha 11, which declared `diff ^7`), and once the dependant moves past it the
 * same entry holds the dependency BELOW what the dependant now declares: measured 2026-09-24, mocha 12.0.x declares
 * `diff ^9.0.0` and the entry installs diff 8.0.4 in eleven adapters — a version mocha 12 was never released against,
 * while the version it declares is past the advisory the entry was written for. An override that lifts a dependency
 * ABOVE the declared range (`esbuild >=0.25.0`, a security floor) is the purpose of the field and stays allowed.
 *
 * Judged from `package-lock.json` (lockfile v2/v3 `packages`), the tree `npm ci` installs: for every installed package
 * and every dependency it declares whose name the `overrides` block touches, the instance node's resolution loads
 * (nested first, then each enclosing `node_modules`) must not be below the lowest version the declared range admits.
 * Ranges that are no version range (`npm:` aliases, `file:`, URLs, tags) are not judged. With `overrides` but no
 * readable lockfile the check says so instead of staying silent.
 */
export const overrideBelowParentCheck: Check = {
  id: "override-below-parent",
  title:
    "an `overrides` entry never installs a dependency below the range its dependant declares",
  run(adapterDir: string): Finding[] {
    const pkg = readJson<Record<string, unknown>>(adapterDir, "package.json");
    const overrides = pkg?.overrides;
    if (
      typeof overrides !== "object" ||
      overrides === null ||
      Object.keys(overrides).length === 0
    ) {
      return [];
    }
    const names = overriddenNames(overrides);
    const lock = readJson<{ packages?: Record<string, LockEntry> }>(
      adapterDir,
      "package-lock.json",
    );
    const packages = lock?.packages;
    if (typeof packages !== "object" || packages === null) {
      return [
        {
          check: overrideBelowParentCheck.id,
          file: "package-lock.json",
          message:
            "package.json carries `overrides`, but package-lock.json is missing, unreadable or has no `packages`",
          impact:
            "without the lockfile the installed tree is unknown, so an override below its dependant's range cannot be judged",
        },
      ];
    }
    const findings: Finding[] = [];
    const seen = new Set<string>();
    for (const [from, entry] of Object.entries(packages)) {
      if (!from) {
        continue; // the adapter itself: its own ranges are what it declares
      }
      const declared = {
        ...(typeof entry.dependencies === "object" && entry.dependencies
          ? entry.dependencies
          : {}),
        ...(typeof entry.optionalDependencies === "object" &&
        entry.optionalDependencies
          ? entry.optionalDependencies
          : {}),
      } as Record<string, unknown>;
      for (const [name, range] of Object.entries(declared)) {
        if (!names.has(name) || typeof range !== "string") {
          continue;
        }
        const floor = lowestAdmitted(range);
        const at = resolveInstalled(packages, from, name);
        const installedText = at ? packages[at]?.version : undefined;
        const installed =
          typeof installedText === "string"
            ? parseVersion(installedText)
            : undefined;
        if (!floor || !installed || compare(installed, floor) >= 0) {
          continue;
        }
        const dependant = from.slice(
          from.lastIndexOf("node_modules/") + "node_modules/".length,
        );
        const dependantVersion =
          typeof entry.version === "string" ? `@${entry.version}` : "";
        const key = `${name}@${String(installedText)} ${dependant}${dependantVersion} ${range}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        findings.push({
          check: overrideBelowParentCheck.id,
          file: "package.json",
          message: `\`overrides\` installs ${name} ${String(installedText)}, below the ${range} that ${dependant}${dependantVersion} declares`,
          impact:
            `${dependant} runs against a ${name} it was never released with; an override written for an older ` +
            `${dependant} is obsolete once the declared range is past the version it pinned — remove the entry or raise it`,
        });
      }
    }
    return findings;
  },
};
