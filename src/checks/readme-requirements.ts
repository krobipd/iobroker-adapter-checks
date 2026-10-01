import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Check, Finding } from "../types.js";
import { readJson, readText } from "../util.js";

/**
 * A requirement statement: `[ioBroker ]<name> >= <version>` (or `≥`) in any form — bold, list item, running text, with
 * text after it. Until 0.22.0 only `**ioBroker <name> >= x**` and `- ioBroker <name> >= x` at the line end counted, so
 * `- admin >= <old>` stayed green in three adapters while the manifest asked for more (yamaha 523d891 — the release
 * fixer raised the manifest, not the README line). The version compared against is always the manifest's, read live.
 * Measured 2026-09-29 over the fleet and the forks: before the changelog heading no statement names something other
 * than a dependency.
 */
const REQUIREMENT_RE =
  /(?<![\w.-])(?:ioBroker\s+)?([A-Za-z][\w.-]*)\s*(?:>=|≥)\s*v?(\d+(?:\.\d+)*)/g;

/**
 * The same statement written as `<name> <version> or newer` / `oder neuer` (0.23.0) — the user documentation
 * (`common.docs` → `docs/<lang>/README.md`) writes it that way. On every page a line with the Sentry sentence ("Error
 * reporting requires js-controller 3.0 or newer") is left out: it names the plugin's requirement, not the adapter's.
 */
const NEWER_RE =
  /(?<![\w.-])(?:ioBroker\s+)?([A-Za-z][\w.-]*)\s+v?(\d+(?:\.\d+)*)(?=\s+(?:or newer|or higher|oder neuer|oder höher)\b)/gi;

/** The changelog heading — what follows is history ("Adapter requires admin >= 7.7.22 now"), not a promise. */
const CHANGELOG_RE = /^#{1,3}\s*Changelog/im;

/**
 * Every requirement statement the README makes before its changelog, in order.
 *
 * @param text the README
 * @returns lower-cased name and version of each statement
 */
function readmeRequirements(text: string): { name: string; version: string }[] {
  const changelog = CHANGELOG_RE.exec(text);
  const head = changelog ? text.slice(0, changelog.index) : text;
  const out: { name: string; version: string }[] = [];
  for (const re of [REQUIREMENT_RE, NEWER_RE]) {
    for (const m of head.matchAll(re)) {
      const line = head.slice(head.lastIndexOf("\n", m.index) + 1, m.index);
      // the Sentry sentence names the plugin's requirement, never the adapter's — on any page
      if (m[1] && m[2] && !line.includes("Error reporting requires")) {
        out.push({ name: m[1].toLowerCase(), version: m[2] });
      }
    }
  }
  return out;
}

/**
 * The user documentation pages, one per language.
 *
 * @param adapterDir the adapter root
 * @returns repo-relative paths of every `docs/<lang>/README.md`
 */
function docsPages(adapterDir: string): string[] {
  try {
    return readdirSync(join(adapterDir, "docs"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `docs/${d.name}/README.md`)
      .filter((rel) => readText(adapterDir, rel) !== undefined)
      .sort();
  } catch {
    return [];
  }
}

/** Shape of the dependency lists in io-package.json. */
interface Manifest {
  common?: {
    dependencies?: unknown[];
    globalDependencies?: unknown[];
  };
}

/**
 * Minimum versions the manifest declares, keyed by dependency name.
 *
 * @param manifest the parsed io-package.json
 * @returns dependency name to version, comparison prefix stripped
 */
function manifestRequirements(
  manifest: Manifest | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const list of [
    manifest?.common?.dependencies,
    manifest?.common?.globalDependencies,
  ]) {
    for (const entry of list ?? []) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      for (const [name, value] of Object.entries(entry)) {
        if (typeof value === "string") {
          out.set(name.toLowerCase(), value.replace(/^[>=\s]+/, "").trim());
        }
      }
    }
  }
  return out;
}

/**
 * Whether version `a` is below `b` (numeric x.y.z; missing parts count as 0).
 *
 * @param a a version
 * @param b a version
 * @returns true when a < b
 */
function isOlder(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d < 0;
    }
  }
  return false;
}

/**
 * What the README promises matches what the adapter actually requires.
 *
 * The README is where a user decides whether their installation is new enough; it states exactly what the manifest
 * requires. An OLDER version there and the install refuses after the user was told it would work; a NEWER one and a
 * user with a working installation believes it has to be upgraded first. Both are reported — the text below said
 * "older" only until 0.15.0 while the code already reported every difference (tooling audit 2026-09-24, P10).
 */
export const readmeRequirementsCheck: Check = {
  id: "readme-requirements",
  title: "the requirements in the README match the manifest",
  run(adapterDir: string): Finding[] {
    const manifest = readJson<Manifest>(adapterDir, "io-package.json");
    if (manifest === undefined) {
      return [];
    }
    const findings: Finding[] = [];
    for (const file of ["README.md", ...docsPages(adapterDir)]) {
      const text = readText(adapterDir, file);
      if (text !== undefined) {
        findings.push(...judge(adapterDir, file, text, manifest));
      }
    }
    return findings;
  },
};

/**
 * The findings of one page.
 *
 * @param adapterDir the adapter root
 * @param file the page, repo-relative
 * @param readme its text
 * @param manifest the parsed io-package.json
 * @returns the findings
 */
function judge(
  adapterDir: string,
  file: string,
  readme: string,
  manifest: Manifest,
): Finding[] {
  const docs = file !== "README.md";
  const findings: Finding[] = [];
  const declared = manifestRequirements(manifest);

  for (const { name, version: readmeVersion } of readmeRequirements(readme)) {
    if (name === "node.js") {
      continue;
    }
    const manifestVersion = declared.get(name);
    if (manifestVersion !== undefined && manifestVersion !== readmeVersion) {
      findings.push({
        check: readmeRequirementsCheck.id,
        file,
        message: `${name}: ${docs ? file : "README"} says >= ${readmeVersion}, the manifest requires >= ${manifestVersion}`,
        impact: isOlder(readmeVersion, manifestVersion)
          ? "a user follows the README and the install then refuses the adapter"
          : "the README asks for more than the adapter needs — a user with a working installation is sent to upgrade first",
      });
    }
  }

  const engines = readJson<{ engines?: { node?: string } }>(
    adapterDir,
    "package.json",
  )?.engines?.node;
  const requiredMajor = engines
    ? Number.parseInt(engines.replace(/^[>=\s]+/, ""), 10)
    : NaN;
  const stated = readmeRequirements(readme).find(
    (r) => r.name === "node.js",
  )?.version;
  if (stated && Number.isFinite(requiredMajor)) {
    const statedMajor = Number.parseInt(stated, 10);
    // Higher in the README is fine — the adapter simply asks for less than it says.
    if (statedMajor < requiredMajor) {
      findings.push({
        check: readmeRequirementsCheck.id,
        file,
        message: `Node.js: ${docs ? file : "README"} says >= ${statedMajor}, package.json requires >= ${requiredMajor}`,
        impact: "the install fails on a Node the README declared as sufficient",
      });
    }
  }

  return findings;
}
