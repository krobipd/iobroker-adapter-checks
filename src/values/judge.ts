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
 * Form rules (round 123, krobi 2026-10-15: "alle datentypen, alle rollen, alle eigenschaften vollständig"; plan
 * Entwicklung/specs/2026-10-15-datenpunkt-form-plan.html). Only rules the primary source carries and ioBroker.shelly
 * passes live here; the fleet's own rules sit in the release gate D08:
 * - `onoff-as-text` — a text state whose list is exactly one on/off pair is an on/off value, and the role
 *   catalog (docs/en/dev/stateroles.md) gives on/off only as boolean (`switch`, `sensor`, `indicator`).
 * - `info-role` — a leaf named firmware, hardware, model, serial, mac, ip or port carries the catalog's info role
 *   (stateroles.md, section Info).
 * - `unit-on-non-number` — `common.unit` is the unit of a number (objectsschema.md, state `common.unit`).
 * - `min-above-max`, `step-not-positive` — the range and step of a number (objectsschema.md, `common.min/max/step`).
 * - `default-not-allowed` — `common.def` lies inside min/max and is a key of `common.states` where the list is the
 *   whole range (objectsschema.md, `common.states`: "Only these values are allowed").
 * - `list-keys-type` — a number state's list keys are numbers: the key is the value the state takes.
 * - `unit-value` — the value of a number with a unit is in that unit (objectsschema.md, state `common.unit`: the unit of
 *   the value). Type, range and unit can all be right while the value stands in another unit (round 180, krobi
 *   2026-11-15: whoever checks the unit also checks that the value matches it): the inventory run proves it against a
 *   value the program or device recorded in its own unit. {@link UNIT_VALUES_FILE} names, per kind of datapoint, one
 *   datapoint, the number its recording carries, that number's unit and the recorded file under `test/` it stands in;
 *   converted to `common.unit`, the inventory value lies within {@link UNIT_TOLERANCE} of it. A kind is the datapoints a
 *   pattern covers on one device (the nearest `device` object, else the first segment) with the same last segment, role
 *   and unit — `*` stands for the entries of a list. A number with a unit that no entry covers is a finding, and so is a
 *   recorded 0 (it tells no unit apart) and a sample without a number value in the inventory (the fixtures never
 *   produce it). A value the adapter computes from several recorded numbers (a share, a time left, a sum over programs —
 *   no recording carries the result) is proven by the operation over them instead: `computed` names a sum, mean,
 *   difference or quotient of recorded numbers, each in its unit and its file, worked out in the datapoint's unit
 *   (round 182). Needs the recorded values (`unitValues`); a live tree (`partialTree`) is not judged.
 *
 * A finding the adapter cannot fix is declared in `test/readable-values.json` —
 * `{ "<pattern>": { "<rule>": "<reason>" } }`, the pattern without namespace, `*` standing for
 * exactly one id segment. A declaration that covers no datapoint, or covers datapoints the rule
 * does not flag, or gives a reason shorter than {@link MIN_REASON_CHARS}, is itself a finding.
 */

import {
  computeUnit,
  convertUnit,
  OPERATIONS,
  type Operation,
  type Term,
} from "./units.js";

export const RULES = [
  "state-list",
  "label-repeats-key",
  "label-language",
  "enum-without-list",
  "encoded-value",
  "onoff-as-text",
  "info-role",
  "unit-on-non-number",
  "min-above-max",
  "step-not-positive",
  "default-not-allowed",
  "list-keys-type",
  "id-language",
  "same-name",
  "unit-value",
] as const;
export type RuleId = (typeof RULES)[number];

/** A reason shorter than this is a shrug, not a reason (same bar as the description declaration). */
export const MIN_REASON_CHARS = 15;

/**
 * Declaration key for label texts that are the same word in every language (an Italian coffee name, a
 * brand): `{ "$sameInEveryLanguage": { "<label text>": "<reason>" } }`. A label listed here is not reported
 * by `label-language` for staying the same in the second language; a pattern-wide exception would also
 * hide the labels of the same list that do need a translation.
 */
export const SAME_IN_EVERY_LANGUAGE = "$sameInEveryLanguage";

/** The declaration file, relative to the adapter root. */
export const DECLARATION_FILE = "test/readable-values.json";

/**
 * The recorded values of the `unit-value` rule, relative to the adapter root:
 * `{ "<pattern>": { "id": "<datapoint>", "recorded": <number>, "unit": "<its unit>", "file": "test/<recording>" } }`, or for
 * a computed value `{ "<pattern>": { "id": "<datapoint>", "computed": { "<sum|mean|difference|quotient|product|min|max>": [<terms>] } } }`,
 * a term being a recorded number `{ "recorded", "unit", "file" }` or another operation.
 */
export const UNIT_VALUES_FILE = "test/unit-values.json";

/** How far the inventory value may lie from the converted recorded value — a share of the latter (rounding for display). */
export const UNIT_TOLERANCE = 0.05;

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
  /**
   * The objects are ONE installation's tree, not the adapter's full inventory: groups the user
   * switched off and devices he does not own are missing. A declaration that matches nothing here,
   * or whose rule nothing here breaks, is not refuted by such a tree — those coverage faults are
   * reported as not judged; the inventory run judges them over every fixture device.
   */
  partialTree?: boolean;
  /**
   * Parsed {@link UNIT_VALUES_FILE} (`{}` when the adapter has none), or undefined when the caller gave no recorded
   * values — then `unit-value` is reported as not judged.
   */
  unitValues?: unknown;
  /** Reads a file of the adapter by its path relative to the root; undefined when it does not exist. */
  readFile?: (path: string) => string | undefined;
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

/**
 * Object ids are fixed English and never depend on the system language (mcm1957; ids carry no translation): the run in a
 * second system language creates exactly the ids of the first. An id that only one of the two runs created is a finding
 * on the side where it appears.
 *
 * @param first objects dump of the first system language
 * @param second objects dump of the second system language
 * @returns one finding per id that only one run created
 */
function idLanguageFindings(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
): RawFinding[] {
  const a = new Set(Object.keys(first).map(stripNamespace));
  const b = new Set(Object.keys(second).map(stripNamespace));
  const out: RawFinding[] = [];
  for (const id of [...a].filter((x) => !b.has(x)).sort()) {
    out.push({
      rule: "id-language",
      id,
      message:
        "created only in the first system language — an id never depends on the language",
    });
  }
  for (const id of [...b].filter((x) => !a.has(x)).sort()) {
    out.push({
      rule: "id-language",
      id,
      message:
        "created only in the second system language — an id never depends on the language",
    });
  }
  return out;
}

/**
 * No device carries two datapoints with the same name — in no language, also across channels (fleet rule D19, krobi
 * 2026-10-20; measured on homeconnect 2026-09-12: 27 collisions in five groups, one in German only). Per language the
 * name the admin shows: the language's text, else English; a plain string in every language. Compared without case and
 * surplus spaces. Only the names have to differ — the tree stays as it is ("Segment 1 brightness", not a new channel).
 *
 * @param objects objects dump of one language run
 * @returns one finding per datapoint of a group, naming the others and the languages
 */
function sameNameFindings(objects: Record<string, unknown>): RawFinding[] {
  const devices = Object.entries(objects)
    .filter(([, o]) => isRecord(o) && o.type === "device")
    .map(([id]) => stripNamespace(id))
    .sort((a, b) => b.length - a.length);
  const states = [...stateObjects(objects).values()];
  const langs = new Set<string>();
  for (const { common } of states) {
    if (isRecord(common.name)) {
      Object.keys(common.name).forEach((l) => langs.add(l));
    }
  }
  if (langs.size === 0) {
    langs.add("en");
  }
  const groups = new Map<string, Set<string>>();
  for (const { id, common } of states) {
    const device = devices.find((d) => id.startsWith(`${d}.`));
    if (device === undefined) {
      continue;
    }
    for (const lang of langs) {
      const name = common.name;
      const text = isRecord(name) ? (name[lang] ?? name.en) : name;
      if (typeof text !== "string" || !text.trim()) {
        continue;
      }
      const key = `${device}\u0000${lang}\u0000${text.split(/\s+/).filter(Boolean).join(" ").toLowerCase()}`;
      const members = groups.get(key) ?? new Set<string>();
      members.add(id);
      groups.set(key, members);
    }
  }
  const byMembers = new Map<string, string[]>();
  for (const [key, members] of groups) {
    if (members.size > 1) {
      const lang = key.split("\u0000")[1] ?? "";
      const k = [...members].sort().join("\u0001");
      byMembers.set(k, [...(byMembers.get(k) ?? []), lang]);
    }
  }
  const out: RawFinding[] = [];
  for (const [k, langList] of byMembers) {
    const members = k.split("\u0001");
    for (const id of members) {
      out.push({
        rule: "same-name",
        id,
        message: `same name as ${members.filter((m) => m !== id).join(", ")} in ${langList.sort().join(", ")} — the name says which datapoint it is`,
      });
    }
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
/**
 * Text shapes that pass the base64 alphabet: a word of four lower-case letters (`Cortex-A72`, `nvme0n1`) and a
 * path (`/dev/ttyS0`). Measured on the fleet's value dumps 2026-09-28 — the binary values of homeconnect carry
 * no lower-case run longer than two.
 */
const TEXT_SHAPE = /[a-z]{4}|^\/[\w.-]+\//;

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
  if (BASE64.test(text) && !CAMEL_WORD.test(text) && !TEXT_SHAPE.test(text)) {
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

/** On/off pairs, compared without case — the keys of a two-value list that is really a boolean. */
const ONOFF_PAIRS = [
  ["on", "off"],
  ["true", "false"],
  ["yes", "no"],
  ["enabled", "disabled"],
  ["active", "inactive"],
  ["open", "closed"],
];

/** Leaf name (lower case, without `_` and `-`) → the role the catalog's Info section gives it. */
const INFO_ROLES: Record<string, string> = {
  firmware: "info.firmware",
  hardware: "info.hardware",
  model: "info.model",
  serial: "info.serial",
  serialnumber: "info.serial",
  mac: "info.mac",
  macaddress: "info.mac",
  ip: "info.ip",
  ipaddress: "info.ip",
  port: "info.port",
};

const NUMERIC_KEY = /^-?\d+(?:\.\d+)?$/;

/**
 * The form findings of one state object — what its `common` block says, without its value.
 *
 * @param id datapoint id without namespace
 * @param common the state's common block
 * @returns the findings
 */
function formFindings(
  id: string,
  common: Record<string, unknown>,
): RawFinding[] {
  const out: RawFinding[] = [];
  const list = isRecord(common.states) ? common.states : undefined;
  const keys = list ? Object.keys(list).map((k) => k.toLowerCase()) : [];
  if (
    common.type === "string" &&
    keys.length === 2 &&
    ONOFF_PAIRS.some((pair) => pair.every((k) => keys.includes(k)))
  ) {
    out.push({
      rule: "onoff-as-text",
      id,
      message: `list ${Object.keys(list ?? {}).join("/")} is on/off — a boolean (switch, sensor or indicator)`,
    });
  }
  const leaf = (id.split(".").pop() ?? "").toLowerCase().replace(/[_-]/g, "");
  const want = INFO_ROLES[leaf];
  const role = typeof common.role === "string" ? common.role : "";
  if (want && role !== want && !role.startsWith(`${want}.`)) {
    out.push({
      rule: "info-role",
      id,
      message: `role "${role}" — the role catalog gives this datapoint ${want}`,
    });
  }
  if (
    typeof common.unit === "string" &&
    common.unit !== "" &&
    common.type !== "number"
  ) {
    out.push({
      rule: "unit-on-non-number",
      id,
      message: `unit "${common.unit}" on a ${String(common.type)} — a unit belongs to a number`,
    });
  }
  if (
    typeof common.min === "number" &&
    typeof common.max === "number" &&
    common.min > common.max
  ) {
    out.push({
      rule: "min-above-max",
      id,
      message: `min ${common.min} above max ${common.max}`,
    });
  }
  if (typeof common.step === "number" && common.step <= 0) {
    out.push({
      rule: "step-not-positive",
      id,
      message: `step ${common.step} — a step is above 0`,
    });
  }
  if (
    common.def !== undefined &&
    common.def !== null &&
    !defaultAllowed(common)
  ) {
    out.push({
      rule: "default-not-allowed",
      id,
      message: `default ${JSON.stringify(common.def)} is outside min/max or not in common.states`,
    });
  }
  if (
    common.type === "number" &&
    list &&
    Object.keys(list).some((k) => !NUMERIC_KEY.test(k))
  ) {
    out.push({
      rule: "list-keys-type",
      id,
      message: `list keys ${Object.keys(list)
        .filter((k) => !NUMERIC_KEY.test(k))
        .slice(0, 4)
        .join(", ")} on a number — the key is the value`,
    });
  }
  return out;
}

function defaultAllowed(common: Record<string, unknown>): boolean {
  const def = common.def;
  if (typeof def === "number") {
    if (
      (typeof common.min === "number" && def < common.min) ||
      (typeof common.max === "number" && def > common.max)
    ) {
      return false;
    }
  }
  if (
    isRecord(common.states) &&
    (typeof def === "string" || typeof def === "number")
  ) {
    return inList(common, def);
  }
  return true;
}

interface RawFinding {
  rule: RuleId;
  id: string;
  message: string;
}

function rawFindings(
  input: ValueInput,
  notJudged: string[],
  sameLabels: ReadonlyMap<string, string>,
  usedSameLabels: Set<string>,
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
  if (input.objectsOtherLanguage) {
    list.push(...idLanguageFindings(input.objects, input.objectsOtherLanguage));
  }
  // both language runs: a plain-string name differs per run
  const seenSameName = new Set<string>();
  for (const dump of [input.objects, input.objectsOtherLanguage ?? {}]) {
    for (const f of sameNameFindings(dump)) {
      if (!seenSameName.has(`${f.id}\u0000${f.message}`)) {
        seenSameName.add(`${f.id}\u0000${f.message}`);
        list.push(f);
      }
    }
  }
  let withValue = 0;
  let withList = 0;
  for (const [id, { common }] of [...objects].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    list.push(...formFindings(id, common));
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
          .filter(([, l]) => {
            if (sameLabels.has(String(l))) {
              usedSameLabels.add(String(l));
              return false;
            }
            return true;
          })
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
  list.push(...unitValueFindings(input, objects, fullIds, notJudged));
  return { list, counts: { states: objects.size, withValue, withList } };
}

/** A number token as a recording writes it (JSON, XML, a text protocol). */
const NUMBER_TOKEN = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** One recorded number of a {@link UNIT_VALUES_FILE} entry. */
interface Leaf {
  recorded: number;
  unit: string;
  file: string;
}

const LEAF_FIELDS =
  '"recorded": <number>, "unit": "<its unit>", "file": "test/<recording>"';
const OPERATION_SHAPE = `{ "<${OPERATIONS.join("|")}>": [<terms>] }`;
const ENTRY_SHAPE = `{ "id": "<datapoint>", ${LEAF_FIELDS} } or { "id": "<datapoint>", "computed": ${OPERATION_SHAPE} }`;
const TERM_SHAPE = `"computed" expects { ${LEAF_FIELDS} } or ${OPERATION_SHAPE}`;
/** The operations that take exactly two terms; the others take two or more. */
const PAIR_OPERATIONS: readonly Operation[] = ["difference", "quotient"];

function hasUnit(
  common: Record<string, unknown>,
): common is Record<string, unknown> & { unit: string } {
  return (
    common.type === "number" &&
    typeof common.unit === "string" &&
    common.unit !== ""
  );
}

/**
 * The `unit-value` findings: every number with a unit covered by a recorded or computed value of its kind, and that value
 * proving the inventory value in the datapoint's unit.
 *
 * @param input the judged input
 * @param objects the state objects by id without namespace
 * @param fullIds id without namespace → full id of the states dump
 * @param notJudged where a reason not to judge goes
 * @returns the findings
 */
function unitValueFindings(
  input: ValueInput,
  objects: Map<string, StateObject>,
  fullIds: Map<string, string>,
  notJudged: string[],
): RawFinding[] {
  if (input.unitValues === undefined) {
    notJudged.push(
      `unit-value: no recorded values given (${UNIT_VALUES_FILE})`,
    );
    return [];
  }
  if (input.partialTree) {
    notJudged.push(
      "unit-value: one installation's live values, not a recording — the inventory run judges it",
    );
    return [];
  }
  const out: RawFinding[] = [];
  const declared = input.unitValues;
  if (!isRecord(declared)) {
    return [
      {
        rule: "unit-value",
        id: UNIT_VALUES_FILE,
        message:
          'expected { "<pattern>": { "id", "recorded", "unit", "file" } }',
      },
    ];
  }
  const devices = Object.entries(input.objects)
    .filter(([, o]) => isRecord(o) && o.type === "device")
    .map(([id]) => stripNamespace(id))
    .sort((a, b) => b.length - a.length);
  const kindOf = (id: string, common: Record<string, unknown>): string =>
    [
      devices.find((d) => id.startsWith(`${d}.`)) ?? id.split(".")[0],
      id.split(".").pop(),
      String(common.role),
      String(common.unit),
    ].join("\u0000");
  const withUnit = [...objects]
    .filter(([, { common }]) => hasUnit(common))
    .sort(([a], [b]) => a.localeCompare(b));
  const patterns = Object.keys(declared);
  for (const [id, { common }] of withUnit) {
    if (!patterns.some((p) => patternMatches(p, id))) {
      out.push({
        rule: "unit-value",
        id,
        message: `no entry in ${UNIT_VALUES_FILE} covers this number in "${String(common.unit)}" — name one datapoint of its kind with the value its recording carries`,
      });
    }
  }
  for (const [pattern, entry] of Object.entries(declared)) {
    const fault = (message: string): void => {
      out.push({ rule: "unit-value", id: pattern, message });
    };
    const covered = withUnit.filter(([id]) => patternMatches(pattern, id));
    if (covered.length === 0) {
      fault("pattern covers no number with a unit");
      continue;
    }
    const kinds = new Map(
      covered.map(([id, { common }]) => [kindOf(id, common), id]),
    );
    if (kinds.size > 1) {
      fault(
        `covers more than one kind (${[...kinds.values()].slice(0, 2).join(", ")}) — one recorded value speaks for the datapoints of one device with the same name, role and unit`,
      );
      continue;
    }
    const direct = isRecord(entry) && isLeaf(entry) && !("computed" in entry);
    const computed =
      isRecord(entry) &&
      "computed" in entry &&
      !("recorded" in entry || "unit" in entry || "file" in entry);
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !(direct || computed)
    ) {
      fault(`expected ${ENTRY_SHAPE}`);
      continue;
    }
    const sample = covered.find(([id]) => id === entry.id);
    if (!sample) {
      fault(
        `sample "${entry.id}" is not a number with a unit this pattern covers`,
      );
      continue;
    }
    const [sampleId, { common }] = sample;
    const actual = valueOf(input.states, sampleId, fullIds);
    // a JSON dump holds no NaN or Infinity; a recorded NaN parses from no token of the file below
    if (typeof actual !== "number") {
      fault(
        `sample "${sampleId}" has no number value in the inventory — the fixtures never produce one`,
      );
      continue;
    }
    const unit = String(common.unit);
    let readings: number[];
    let what: string;
    if (isLeaf(entry)) {
      if (entry.recorded === 0) {
        fault(
          "a recorded 0 tells no unit apart — name a datapoint whose recording carries another number",
        );
        continue;
      }
      const missing = notRecorded(entry, input.readFile);
      if (missing) {
        fault(missing);
        continue;
      }
      const converted = convertUnit(entry.recorded, entry.unit, unit);
      if (!converted) {
        fault(
          `cannot convert "${entry.unit}" to "${unit}" — give the unit the recording carries`,
        );
        continue;
      }
      readings = converted;
      what = `the recorded ${entry.recorded} ${entry.unit}`;
    } else {
      const leaves: Leaf[] = [];
      const term = parseTerm(entry.computed, leaves);
      if (typeof term === "string") {
        fault(term);
        continue;
      }
      if ("value" in term) {
        fault(
          '"computed" holds one recorded number — give it as "recorded", "unit" and "file"',
        );
        continue;
      }
      const missing = leaves
        .map((leaf) => notRecorded(leaf, input.readFile))
        .find((m) => m !== undefined);
      if (missing) {
        fault(missing);
        continue;
      }
      const result = computeUnit(term, unit);
      if ("fault" in result) {
        fault(result.fault);
        continue;
      }
      if (result.readings.every((r) => r === 0)) {
        fault(
          "a computed 0 tells no unit apart — name a datapoint whose recordings give another number",
        );
        continue;
      }
      readings = result.readings;
      what = `the value computed from ${leaves.length} recorded numbers`;
    }
    if (
      !readings.some(
        (r) => Math.abs(actual - r) <= UNIT_TOLERANCE * Math.abs(r),
      )
    ) {
      out.push({
        rule: "unit-value",
        id: sampleId,
        message: `value ${actual} ${unit}, but ${what} is ${readings
          .map((r) => Number(r.toPrecision(4)))
          .join(" or ")} ${unit}`,
      });
    }
  }
  return out;
}

function isLeaf(
  v: Record<string, unknown>,
): v is Record<string, unknown> & Leaf {
  return (
    typeof v.recorded === "number" &&
    typeof v.unit === "string" &&
    v.unit !== "" &&
    typeof v.file === "string"
  );
}

/**
 * Read a computed value of an entry: a recorded number, or an operation over terms.
 *
 * @param raw the parsed JSON
 * @param leaves where every recorded number goes, for the file check
 * @returns the term, or what is wrong with its form
 */
function parseTerm(raw: unknown, leaves: Leaf[]): Term | string {
  if (!isRecord(raw)) {
    return TERM_SHAPE;
  }
  const keys = Object.keys(raw);
  const op = OPERATIONS.find((o) => keys.length === 1 && keys[0] === o);
  if (op === undefined) {
    if (!isLeaf(raw)) {
      return TERM_SHAPE;
    }
    leaves.push({ recorded: raw.recorded, unit: raw.unit, file: raw.file });
    return { value: raw.recorded, unit: raw.unit };
  }
  const list = raw[op];
  const pair = PAIR_OPERATIONS.includes(op);
  if (!Array.isArray(list) || list.length < 2 || (pair && list.length !== 2)) {
    return `"${op}" takes ${pair ? "two terms" : "a list of two or more terms"}`;
  }
  const terms: Term[] = [];
  for (const item of list) {
    const term = parseTerm(item, leaves);
    if (typeof term === "string") {
      return term;
    }
    terms.push(term);
  }
  return { op, terms };
}

/**
 * Why a recorded number does not prove anything: its file is no recording under `test/`, or the number does not stand
 * in it.
 *
 * @param leaf the recorded number with its file
 * @param readFile reads a file of the adapter
 * @returns the fault, or undefined when the number stands in its recording
 */
function notRecorded(
  leaf: Leaf,
  readFile: ValueInput["readFile"],
): string | undefined {
  const file = leaf.file;
  const text =
    file.startsWith("test/") && !file.split("/").includes("..")
      ? readFile?.(file)
      : undefined;
  if (text === undefined) {
    return `"${file}" is no recorded file under test/`;
  }
  if (
    !(text.match(NUMBER_TOKEN) ?? []).some((t) => Number(t) === leaf.recorded)
  ) {
    return `${leaf.recorded} does not stand in ${file} — the value comes from the recording, never from the adapter's run`;
  }
  return undefined;
}

function parseDeclarations(raw: unknown): {
  map: Map<string, Map<RuleId, string>>;
  sameLabels: Map<string, string>;
  errors: ValueFinding[];
} {
  const map = new Map<string, Map<RuleId, string>>();
  const sameLabels = new Map<string, string>();
  const errors: ValueFinding[] = [];
  if (raw === undefined) {
    return { map, sameLabels, errors };
  }
  if (!isRecord(raw)) {
    errors.push({
      rule: "declaration",
      id: DECLARATION_FILE,
      message: 'expected { "<pattern>": { "<rule>": "<reason>" } }',
    });
    return { map, sameLabels, errors };
  }
  for (const [pattern, rules] of Object.entries(raw)) {
    if (pattern === SAME_IN_EVERY_LANGUAGE) {
      if (!isRecord(rules)) {
        errors.push({
          rule: "declaration",
          id: pattern,
          message: 'expected { "<label text>": "<reason>" }',
        });
        continue;
      }
      for (const [label, reason] of Object.entries(rules)) {
        if (
          typeof reason !== "string" ||
          reason.trim().length < MIN_REASON_CHARS
        ) {
          errors.push({
            rule: "declaration",
            id: `${pattern} "${label}"`,
            message: "has no reason, only a shrug",
          });
        }
        sameLabels.set(label, typeof reason === "string" ? reason : "");
      }
      continue;
    }
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
  return { map, sameLabels, errors };
}

/**
 * Judge an adapter's inventory for readable values.
 *
 * @param input objects, states, the second-language objects and the parsed declaration file
 * @returns undeclared findings, declaration findings, the rules that could not be judged and counts
 */
export function judgeValues(input: ValueInput): ValueResult {
  const notJudged: string[] = [];
  const { map, sameLabels, errors } = parseDeclarations(input.declarations);
  const usedSameLabels = new Set<string>();
  const { list, counts } = rawFindings(
    input,
    notJudged,
    sameLabels,
    usedSameLabels,
  );
  const findings: ValueFinding[] = [...errors];
  const coverage = !input.partialTree;
  if (!coverage) {
    notJudged.push(
      "declaration coverage: one installation's tree, not the full inventory — the inventory run judges it",
    );
  }
  if (coverage && !notJudged.some((n) => n.startsWith("label-language:"))) {
    for (const label of sameLabels.keys()) {
      if (!usedSameLabels.has(label)) {
        findings.push({
          rule: "declaration",
          id: `${SAME_IN_EVERY_LANGUAGE} "${label}"`,
          message: "no label with this text stays the same in both languages",
        });
      }
    }
  }
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
  for (const [pattern, rules] of coverage ? map : []) {
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
