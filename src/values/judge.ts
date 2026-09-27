/**
 * Readable values — judges what a user actually SEES in the object tree: the value of every state
 * and the labels of its `common.states` list.
 *
 * Input is an adapter's generated inventory: the objects dump (`test/objects.inventory.json`, the
 * ioBroker object-structure bot's format), the states dump written by the same run
 * (`{ "<id>": { val, ack } }`) and, for the language rule, a second objects dump taken with a
 * different system language. Nothing here reads the network or the adapter's sources.
 *
 * Rules (ids are what a declaration names):
 * - `state-list` — a state with `common.states` only gets values from that list. Source:
 *   ioBroker docs/en/dev/objectsschema.md, `common.states`: "Only these values are allowed";
 *   js-controller does not check it ("not checked or validated by the js-controller"), so a
 *   gate is the only enforcement.
 * - `label-repeats-key` — a label is the displayed text of a value; a label that repeats its key
 *   is the deprecated array form (`['Start']` = `{Start: 'Start'}`, same document) and shows the
 *   user nothing but the raw value.
 * - `label-language` — labels are plain strings in the system language: an object as a label
 *   crashes the admin (React error #31), and a label that stays the same when the system language
 *   changes was never translated.
 * - `enum-without-list` — a read-only text state whose value is an identifier (`cupboarddryplus`,
 *   `fluffing`) carries a device enum and needs a list with labels.
 * - `encoded-value` — no coded raw value: raw JSON, base64 that decodes to binary, long hex blocks.
 *
 * A finding the adapter cannot fix is declared in `test/readable-values.json` —
 * `{ "<pattern>": { "<rule>": "<reason>" } }`, the pattern without namespace, `*` standing for
 * exactly one id segment. A declaration that covers no datapoint, or covers datapoints the rule
 * does not flag, or gives a reason shorter than {@link MIN_REASON_CHARS}, is itself a finding.
 */

export const RULES = [
  "state-list",
  "label-repeats-key",
  "label-language",
  "enum-without-list",
  "encoded-value",
] as const;
export type RuleId = (typeof RULES)[number];

/** A reason shorter than this is a shrug, not a reason (same bar as the description declaration). */
export const MIN_REASON_CHARS = 15;

/** The declaration file, relative to the adapter root. */
export const DECLARATION_FILE = "test/readable-values.json";

/** One datapoint that shows the user something unreadable, or one faulty declaration. */
export interface ValueFinding {
  /** The rule broken, or "declaration" for a fault in the declaration file. */
  rule: RuleId | "declaration";
  /** Datapoint id without namespace, or the declaration pattern. */
  id: string;
  /** What is wrong, in one line. */
  message: string;
}

/** What {@link judgeValues} reads. */
export interface ValueInput {
  /** Objects dump, keyed by full id (`<adapter>.0.<id>`). */
  objects: Record<string, unknown>;
  /** States dump, keyed by full id. */
  states: Record<string, unknown>;
  /**
   * Objects dump from a run with a different system language. Absent means the language rule
   * cannot be judged — the caller has to say so ({@link judgeValues} reports it as not judged).
   */
  objectsOtherLanguage?: Record<string, unknown>;
  /** Parsed declaration file, or undefined when the adapter has none. */
  declarations?: unknown;
}

/** What {@link judgeValues} returns. */
export interface ValueResult {
  /** Undeclared findings and declaration faults. */
  findings: ValueFinding[];
  /** Rules that could not be judged, with the reason — never a silent pass. */
  notJudged: string[];
  /** Size of what was judged, so an empty dump is visible. */
  counts: {
    /** States in the objects dump. */
    states: number;
    /** States with a value other than null. */
    withValue: number;
    /** States with a `common.states` list. */
    withList: number;
  };
}

interface StateObject {
  id: string;
  common: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function stripNamespace(id: string): string {
  const m = /^[^.]+\.\d+\.(.+)$/.exec(id);
  return m?.[1] ?? id;
}

function stateObjects(
  objects: Record<string, unknown>,
): Map<string, StateObject> {
  const out = new Map<string, StateObject>();
  for (const [fullId, obj] of Object.entries(objects)) {
    if (!isRecord(obj) || obj.type !== "state" || !isRecord(obj.common)) {
      continue;
    }
    const id = stripNamespace(fullId);
    out.set(id, { id, common: obj.common });
  }
  return out;
}

function valueOf(
  states: Record<string, unknown>,
  id: string,
  fullIds: Map<string, string>,
): unknown {
  const full = fullIds.get(id);
  const entry = full === undefined ? undefined : states[full];
  return isRecord(entry) ? entry.val : undefined;
}

/**
 * `*` covers exactly one id segment.
 *
 * @param pattern declaration pattern without namespace
 * @param id datapoint id without namespace
 * @returns whether the pattern covers the id
 */
export function patternMatches(pattern: string, id: string): boolean {
  const pp = pattern.split(".");
  const ip = id.split(".");
  return (
    pp.length === ip.length && pp.every((p, i) => p === "*" || p === ip[i])
  );
}

/** Identifier-shaped value: lower-case start, letters/digits/underscore, no space — `cupboarddryplus`. */
const IDENTIFIER = /^[a-z][a-zA-Z0-9_]*$/;
const BASE64 = /^[A-Za-z0-9+/_-]{8,}={0,2}$/;
const HEX_BLOCK = /^(?:[0-9a-fA-F]{2}){8,}$/;
const HAS_LETTER = /\p{L}/u;
/**
 * Unit symbols that read the same in every language; a label made of numbers and these is not
 * text to translate (`40 °C`, `1.5 kWh`). `rpm` is deliberately absent — German writes `U/min`.
 */
const NEUTRAL_UNIT =
  /(?<![\p{L}])(?:°C|°F|K|%|W|kW|kWh|Wh|V|mV|A|mA|Hz|h|min|s|ms|kg|g|l|ml|dB|lux|lx|ppm|µg\/m³|m³|mm|cm|m|km)(?![\p{L}])/gu;

/**
 * Does a label carry words that a translation would change?
 *
 * @param label a `common.states` label
 * @returns whether letters remain once numbers and unit symbols are removed
 */
function hasWords(label: string): boolean {
  return HAS_LETTER.test(label.replace(NEUTRAL_UNIT, ""));
}

/** A word in camel case with an optional number — `LivingRoom2` — is text, not base64. */
const CAMEL_WORD = /^[A-Za-z][a-z]+(?:[A-Z][a-z]+)*\d*$/;

function printableShare(bytes: Buffer): number {
  if (bytes.length === 0) {
    return 1;
  }
  let printable = 0;
  for (const b of bytes) {
    if (b >= 0x20 && b <= 0x7e) {
      printable++;
    }
  }
  return printable / bytes.length;
}

/**
 * Why a string value is a coded raw value, or undefined when it is not.
 *
 * @param value a state value as the adapter wrote it
 * @returns the reason, or undefined for a readable value
 */
export function encodedReason(value: string): string | undefined {
  const text = value.trim();
  if (
    (text.startsWith("{") && text.endsWith("}")) ||
    (text.startsWith("[") && text.endsWith("]"))
  ) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) {
        return "raw JSON — split it into datapoints of their own";
      }
    } catch {
      // not JSON — fall through
    }
  }
  if (HEX_BLOCK.test(text) && /[0-9]/.test(text) && /[a-fA-F]/.test(text)) {
    return "hex block — decode it";
  }
  // Base64 of binary data mixes upper case, lower case and digits; an all-upper tracking or serial
  // number does not, and neither does a camel-case word. An all-upper value still counts when it decodes
  // to NUL bytes — text never carries them (homeconnect: `AEQAGABFAAA` = 00 44 00 18 00 45 00 00).
  if (BASE64.test(text) && !CAMEL_WORD.test(text)) {
    const bytes = Buffer.from(
      text.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    const nulShare =
      bytes.length === 0
        ? 0
        : bytes.filter((b) => b === 0).length / bytes.length;
    const mixed =
      /[a-z]/.test(text) && /[A-Z]/.test(text) && /[0-9+/_=-]/.test(text);
    if (
      bytes.length >= 6 &&
      ((mixed && printableShare(bytes) < 0.75) || nulShare >= 0.25)
    ) {
      return "base64 that decodes to binary data — decode it";
    }
  }
  return undefined;
}

function labelIsString(v: unknown): boolean {
  return typeof v === "string";
}

function inList(common: Record<string, unknown>, value: unknown): boolean {
  const list = common.states;
  if (!isRecord(list)) {
    return true;
  }
  if (Object.prototype.hasOwnProperty.call(list, String(value))) {
    return true;
  }
  // Numbers with min/max: the list names special values, the range is allowed (objectsschema).
  if (typeof value === "number") {
    const min = typeof common.min === "number" ? common.min : undefined;
    const max = typeof common.max === "number" ? common.max : undefined;
    if (min !== undefined || max !== undefined) {
      return (
        (min === undefined || value >= min) &&
        (max === undefined || value <= max)
      );
    }
  }
  return false;
}

interface RawFinding {
  rule: RuleId;
  id: string;
  message: string;
}

function rawFindings(
  input: ValueInput,
  notJudged: string[],
): { list: RawFinding[]; counts: ValueResult["counts"] } {
  const objects = stateObjects(input.objects);
  const fullIds = new Map<string, string>();
  for (const fullId of Object.keys(input.states)) {
    fullIds.set(stripNamespace(fullId), fullId);
  }
  const other = input.objectsOtherLanguage
    ? stateObjects(input.objectsOtherLanguage)
    : undefined;
  if (!other) {
    notJudged.push(
      "label-language: no objects dump from a second system language",
    );
  }
  const list: RawFinding[] = [];
  let withValue = 0;
  let withList = 0;
  for (const [id, { common }] of [...objects].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const value = valueOf(input.states, id, fullIds);
    const hasValue = value !== undefined && value !== null;
    if (hasValue) {
      withValue++;
    }
    const states = isRecord(common.states) ? common.states : undefined;
    if (states) {
      withList++;
      if (
        hasValue &&
        (typeof value === "string" || typeof value === "number") &&
        !inList(common, value)
      ) {
        list.push({
          rule: "state-list",
          id,
          message: `value ${JSON.stringify(value)} is not in common.states`,
        });
      }
      const repeated = Object.entries(states)
        .filter(([k, l]) => labelIsString(l) && k === l)
        .map(([k]) => k);
      if (repeated.length > 0) {
        const shown =
          repeated.slice(0, 6).join(", ") + (repeated.length > 6 ? ", …" : "");
        list.push({
          rule: "label-repeats-key",
          id,
          message: `${repeated.length} label(s) only repeat their value: ${shown}`,
        });
      }
      const objectLabels = Object.entries(states)
        .filter(([, l]) => !labelIsString(l))
        .map(([k]) => k);
      if (objectLabels.length > 0) {
        list.push({
          rule: "label-language",
          id,
          message: `label(s) for ${objectLabels.join(", ")} are not plain strings — the admin cannot render them`,
        });
      }
      const otherStates = other?.get(id)?.common.states;
      if (isRecord(otherStates)) {
        const untranslated = Object.entries(states)
          .filter(
            ([k, l]) =>
              typeof l === "string" &&
              k !== l &&
              hasWords(l) &&
              otherStates[k] === l,
          )
          .map(([k, l]) => `${k}=${String(l)}`);
        if (untranslated.length > 0) {
          const shown =
            untranslated.slice(0, 6).join(", ") +
            (untranslated.length > 6 ? ", …" : "");
          list.push({
            rule: "label-language",
            id,
            message: `${untranslated.length} label(s) stay the same in both system languages: ${shown}`,
          });
        }
      }
    } else if (
      typeof value === "string" &&
      common.type === "string" &&
      common.write !== true &&
      IDENTIFIER.test(value)
    ) {
      list.push({
        rule: "enum-without-list",
        id,
        message: `value "${value}" is an identifier without a list of labels`,
      });
    }
    if (typeof value === "string") {
      const why = encodedReason(value);
      if (why) {
        // An encoded value is reported as such, not a second time as a missing list.
        const i = list.findIndex(
          (f) => f.id === id && f.rule === "enum-without-list",
        );
        if (i >= 0) {
          list.splice(i, 1);
        }
      }
      if (why) {
        const shown = value.length > 40 ? `${value.slice(0, 37)}…` : value;
        list.push({
          rule: "encoded-value",
          id,
          message: `value "${shown}": ${why}`,
        });
      }
    }
  }
  return { list, counts: { states: objects.size, withValue, withList } };
}

function parseDeclarations(raw: unknown): {
  map: Map<string, Map<RuleId, string>>;
  errors: ValueFinding[];
} {
  const map = new Map<string, Map<RuleId, string>>();
  const errors: ValueFinding[] = [];
  if (raw === undefined) {
    return { map, errors };
  }
  if (!isRecord(raw)) {
    errors.push({
      rule: "declaration",
      id: DECLARATION_FILE,
      message: 'expected { "<pattern>": { "<rule>": "<reason>" } }',
    });
    return { map, errors };
  }
  for (const [pattern, rules] of Object.entries(raw)) {
    if (!isRecord(rules)) {
      errors.push({
        rule: "declaration",
        id: pattern,
        message: 'expected { "<rule>": "<reason>" }',
      });
      continue;
    }
    const inner = new Map<RuleId, string>();
    for (const [rule, reason] of Object.entries(rules)) {
      if (!(RULES as readonly string[]).includes(rule)) {
        errors.push({
          rule: "declaration",
          id: pattern,
          message: `unknown rule "${rule}" (known: ${RULES.join(", ")})`,
        });
        continue;
      }
      if (
        typeof reason !== "string" ||
        reason.trim().length < MIN_REASON_CHARS
      ) {
        errors.push({
          rule: "declaration",
          id: pattern,
          message: `"${rule}" has no reason, only a shrug`,
        });
      }
      inner.set(rule as RuleId, typeof reason === "string" ? reason : "");
    }
    map.set(pattern, inner);
  }
  return { map, errors };
}

/**
 * Judge an adapter's inventory for readable values.
 *
 * @param input objects, states, the second-language objects and the parsed declaration file
 * @returns undeclared findings, declaration findings, the rules that could not be judged and counts
 */
export function judgeValues(input: ValueInput): ValueResult {
  const notJudged: string[] = [];
  const { list, counts } = rawFindings(input, notJudged);
  const { map, errors } = parseDeclarations(input.declarations);
  const findings: ValueFinding[] = [...errors];
  const stateIds = [...stateObjects(input.objects).keys()];
  const used = new Set<string>();
  for (const f of list) {
    const covering = [...map].find(
      ([pattern, rules]) => rules.has(f.rule) && patternMatches(pattern, f.id),
    );
    if (covering) {
      used.add(`${covering[0]}\u0000${f.rule}`);
      continue;
    }
    findings.push(f);
  }
  for (const [pattern, rules] of map) {
    if (!stateIds.some((id) => patternMatches(pattern, id))) {
      findings.push({
        rule: "declaration",
        id: pattern,
        message: "pattern matches no datapoint",
      });
      continue;
    }
    for (const rule of rules.keys()) {
      if (
        !used.has(`${pattern}\u0000${rule}`) &&
        !notJudged.some((n) => n.startsWith(`${rule}:`))
      ) {
        findings.push({
          rule: "declaration",
          id: pattern,
          message: `"${rule}" declared, but no datapoint here breaks it`,
        });
      }
    }
  }
  return { findings, notJudged, counts };
}
