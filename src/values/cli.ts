/**
 * `iobroker-adapter-checks values` — judge an adapter's generated inventory for readable values.
 *
 * Not part of `allChecks`: it needs the dumps of an inventory run, which only a release run or the
 * CI inventory job produces, so it never runs in a plain `npm test`.
 *
 * Usage:
 *   iobroker-adapter-checks values --objects <file> --states <file>
 *     (--objects-other-language <file> | --single-language) [--declarations <file>] [--full]
 *
 * Exit 0 = clean, 1 = findings, 2 = could not judge (missing or unreadable input).
 */
import { existsSync, readFileSync } from "node:fs";
import { judgeValues, type ValueFinding } from "./judge.js";

export const USAGE =
  "usage: iobroker-adapter-checks values --objects <file> --states <file> " +
  "(--objects-other-language <file> | --single-language) [--declarations <file>] [--full]";

function readJson(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Run the command.
 *
 * @param argv arguments after the command name
 * @param out where lines go
 * @returns the exit code
 */
export function runValues(
  argv: string[],
  out: (line: string) => void = console.log,
): number {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--single-language" || a === "--full") {
      flags.add(a);
    } else if (a.startsWith("--") && i + 1 < argv.length) {
      args.set(a, argv[++i] ?? "");
    } else {
      out(`unknown argument "${a}"\n${USAGE}`);
      return 2;
    }
  }
  const objectsFile = args.get("--objects");
  const statesFile = args.get("--states");
  const otherFile = args.get("--objects-other-language");
  if (
    !objectsFile ||
    !statesFile ||
    (!otherFile && !flags.has("--single-language"))
  ) {
    out(USAGE);
    return 2;
  }
  let input;
  try {
    const declFile = args.get("--declarations");
    input = {
      objects: readJson(objectsFile),
      states: readJson(statesFile),
      objectsOtherLanguage: otherFile ? readJson(otherFile) : undefined,
      declarations:
        declFile && existsSync(declFile)
          ? (JSON.parse(readFileSync(declFile, "utf8")) as unknown)
          : undefined,
    };
  } catch (err) {
    out(`cannot judge: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const result = judgeValues(input);
  const { states, withValue, withList } = result.counts;
  out(
    `readable values: ${states} states, ${withValue} with a value, ${withList} with a list of labels`,
  );
  for (const n of result.notJudged) {
    out(`  not judged — ${n}`);
  }
  if (states === 0 || withValue === 0) {
    out("cannot judge: the dumps carry no states or no values");
    return 2;
  }
  const byRule = new Map<string, ValueFinding[]>();
  for (const f of result.findings) {
    byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  }
  const limit = flags.has("--full") ? Infinity : 15;
  for (const [rule, list] of byRule) {
    out(`  ✗ ${rule}: ${list.length}`);
    for (const f of list.slice(0, limit)) {
      out(`      ${f.id}: ${f.message}`);
    }
    if (list.length > limit) {
      out(`      … and ${list.length - limit} more (all with --full)`);
    }
  }
  if (result.findings.length === 0) {
    out("  ✓ every value readable");
    return 0;
  }
  return 1;
}
