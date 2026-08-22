import type { Check, Finding } from "../types.js";
import { readJson, readText } from "../util.js";

/** `**ioBroker admin >= 7.4.10**` — the bold form used in a requirements paragraph. */
const BOLD_RE =
  /\*\*ioBroker\s+([A-Za-z][A-Za-z0-9 \-_.]*?)\s+(?:>=|≥)\s+([\d.]+)\*\*/g;

/** `- ioBroker admin >= 7.4.10` — the same statement as a list item. */
const BULLET_RE =
  /^- ioBroker\s+([A-Za-z][A-Za-z0-9 \-_.]*?)\s+(?:>=|≥)\s+([\d.]+)\s*$/gm;

/** `Node.js >= 20` anywhere in the text. */
const NODE_RE = /Node\.js\s*(?:>=|≥)\s*(\d+)/;

/**
 * Requirement lines the README states, keyed by the dependency name.
 *
 * @param text the README
 * @returns lower-cased dependency name to version
 */
function readmeRequirements(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const re of [BOLD_RE, BULLET_RE]) {
    for (const m of text.matchAll(re)) {
      if (m[1] && m[2]) {
        out.set(m[1].trim().toLowerCase(), m[2]);
      }
    }
  }
  return out;
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
 * What the README promises matches what the adapter actually requires.
 *
 * The README is where a user decides whether their installation is new enough. If it
 * states an older js-controller or Node than the adapter really needs, the install
 * fails after the user has already been told it would work.
 */
export const readmeRequirementsCheck: Check = {
  id: "readme-requirements",
  title: "the requirements in the README match the manifest",
  run(adapterDir: string): Finding[] {
    const readme = readText(adapterDir, "README.md");
    const manifest = readJson<Manifest>(adapterDir, "io-package.json");
    if (readme === undefined || manifest === undefined) {
      return [];
    }
    const findings: Finding[] = [];
    const declared = manifestRequirements(manifest);

    for (const [name, readmeVersion] of readmeRequirements(readme)) {
      const manifestVersion = declared.get(name);
      if (manifestVersion !== undefined && manifestVersion !== readmeVersion) {
        findings.push({
          check: readmeRequirementsCheck.id,
          file: "README.md",
          message: `${name}: README says >= ${readmeVersion}, the manifest requires >= ${manifestVersion}`,
          impact:
            "a user follows the README and the install then refuses the adapter",
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
    const stated = NODE_RE.exec(readme);
    if (stated?.[1] && Number.isFinite(requiredMajor)) {
      const statedMajor = Number.parseInt(stated[1], 10);
      // Higher in the README is fine — the adapter simply asks for less than it says.
      if (statedMajor < requiredMajor) {
        findings.push({
          check: readmeRequirementsCheck.id,
          file: "README.md",
          message: `Node.js: README says >= ${statedMajor}, package.json requires >= ${requiredMajor}`,
          impact:
            "the install fails on a Node the README declared as sufficient",
        });
      }
    }

    return findings;
  },
};
