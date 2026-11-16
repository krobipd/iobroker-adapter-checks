/**
 * Unit conversion for the `unit-value` rule: a number a program or device recorded in its own unit, converted to the
 * datapoint's `common.unit`. ioBroker gives `common.unit` as free text ("the unit of the value", objectsschema.md, state
 * `common.unit`), so the table holds the units the role catalog and the fleet use; two units it cannot relate are no
 * conversion, and the same text on both sides is always the identity.
 *
 * A byte prefix without "i" (`kB`, `MB`, `GB`, `TB`, also in a rate) is read as 1000 or 1024 — both are in use for the same
 * text, and a value only has to fit one of them; `KiB`, `MiB`, … are binary only.
 *
 * A value the adapter computes from several recorded numbers (a share of two, a time left from three, a sum over programs)
 * is a {@link Term}: {@link computeUnit} works it out in each kind's base unit and converts the result. Kinds follow the
 * operation — a sum, mean or difference keeps one kind, a quotient divides them (bytes by bytes per second is a time, bytes
 * by bytes a share) — and a temperature, which carries an offset, only averages.
 */

interface UnitDef {
  /** The quantity: units convert only within one. */
  kind: string;
  /** Factors to the kind's base unit; two when the text is read both ways. */
  scales: readonly number[];
  /** Added after scaling (temperatures). */
  offset?: number;
}

const DECIMAL_OR_BINARY = (power: number): readonly number[] => [
  1000 ** power,
  1024 ** power,
];

const LINEAR: Record<string, readonly [string, number | readonly number[]]> = {
  B: ["data", 1],
  kB: ["data", DECIMAL_OR_BINARY(1)],
  KB: ["data", DECIMAL_OR_BINARY(1)],
  KiB: ["data", 1024],
  MB: ["data", DECIMAL_OR_BINARY(2)],
  MiB: ["data", 1024 ** 2],
  GB: ["data", DECIMAL_OR_BINARY(3)],
  GiB: ["data", 1024 ** 3],
  TB: ["data", DECIMAL_OR_BINARY(4)],
  TiB: ["data", 1024 ** 4],
  bit: ["data", 1 / 8],
  kbit: ["data", 1000 / 8],
  Mbit: ["data", 1e6 / 8],
  Gbit: ["data", 1e9 / 8],
  ms: ["time", 0.001],
  s: ["time", 1],
  min: ["time", 60],
  h: ["time", 3600],
  d: ["time", 86400],
  mW: ["power", 0.001],
  W: ["power", 1],
  kW: ["power", 1000],
  MW: ["power", 1e6],
  VA: ["apparent power", 1],
  kVA: ["apparent power", 1000],
  var: ["reactive power", 1],
  kvar: ["reactive power", 1000],
  mWh: ["energy", 0.001],
  Wh: ["energy", 1],
  kWh: ["energy", 1000],
  MWh: ["energy", 1e6],
  mV: ["voltage", 0.001],
  V: ["voltage", 1],
  kV: ["voltage", 1000],
  mA: ["current", 0.001],
  A: ["current", 1],
  mAh: ["charge", 0.001],
  Ah: ["charge", 1],
  Hz: ["frequency", 1],
  kHz: ["frequency", 1000],
  MHz: ["frequency", 1e6],
  GHz: ["frequency", 1e9],
  ratio: ["ratio", 1],
  "%": ["ratio", 0.01],
  "‰": ["ratio", 0.001],
  ml: ["volume", 0.001],
  l: ["volume", 1],
  L: ["volume", 1],
  m3: ["volume", 1000],
  "m³": ["volume", 1000],
  mg: ["mass", 0.001],
  g: ["mass", 1],
  kg: ["mass", 1000],
  t: ["mass", 1e6],
  mm: ["length", 0.001],
  cm: ["length", 0.01],
  m: ["length", 1],
  km: ["length", 1000],
};

/** Bits per second written as one word (`kbps`). */
const PER_SECOND_WORDS: Record<string, string> = {
  bps: "bit/s",
  kbps: "kbit/s",
  Mbps: "Mbit/s",
  Gbps: "Gbit/s",
};

const TEMPERATURE: Record<string, UnitDef> = {
  "°C": { kind: "temperature", scales: [1], offset: 0 },
  K: { kind: "temperature", scales: [1], offset: -273.15 },
  "°F": { kind: "temperature", scales: [5 / 9], offset: -160 / 9 },
};

function linear(unit: string): UnitDef | undefined {
  const entry = LINEAR[unit];
  if (!entry) {
    return undefined;
  }
  const [kind, scale] = entry;
  return { kind, scales: typeof scale === "number" ? [scale] : scale };
}

/**
 * The definition of a unit text, a rate (`MB/s`) as its two sides.
 *
 * @param unit the unit text
 * @returns its kind and factors, or undefined for a text the table does not hold
 */
function definition(unit: string): UnitDef | undefined {
  const text = PER_SECOND_WORDS[unit] ?? unit;
  if (TEMPERATURE[text]) {
    return TEMPERATURE[text];
  }
  const slash = text.indexOf("/");
  if (slash < 0) {
    return linear(text);
  }
  const top = linear(text.slice(0, slash));
  const bottom = linear(text.slice(slash + 1));
  if (!top || !bottom) {
    return undefined;
  }
  return {
    kind: `${top.kind}/${bottom.kind}`,
    scales: top.scales.flatMap((a) => bottom.scales.map((b) => a / b)),
  };
}

/**
 * Convert a number from one unit to another.
 *
 * @param value the number in `from`
 * @param from the unit the recording carries
 * @param to the datapoint's `common.unit`
 * @returns every reading of the value in `to` (two where a byte prefix reads both ways), or undefined when the units
 *   do not convert
 */
export function convertUnit(
  value: number,
  from: string,
  to: string,
): number[] | undefined {
  if (from === to) {
    return [value];
  }
  const a = definition(from);
  const b = definition(to);
  if (!a || !b || a.kind !== b.kind) {
    return undefined;
  }
  // two texts read both ways are read the same way on both sides (2 GB is 2000 MB or 2048 MB, never 2147 MB)
  const pairs =
    a.scales.length === b.scales.length
      ? a.scales.map((sa, i) => [sa, b.scales[i] ?? sa] as const)
      : a.scales.flatMap((sa) => b.scales.map((sb) => [sa, sb] as const));
  return pairs.map(
    ([sa, sb]) => (value * sa + (a.offset ?? 0) - (b.offset ?? 0)) / sb,
  );
}

/** The operations of a computed value. */
export const OPERATIONS = ["sum", "mean", "difference", "quotient"] as const;
export type Operation = (typeof OPERATIONS)[number];

/** A computed value: a recorded number in its unit, or an operation over such terms. */
export type Term =
  | { readonly value: number; readonly unit: string }
  | { readonly op: Operation; readonly terms: readonly Term[] };

/** A value on its way through a {@link Term}. */
interface Quantity {
  /** Exponent per kind; empty for a share. */
  dims: Record<string, number>;
  /** The value in its kind's base unit, once per reading of a byte prefix (decimal, binary). */
  values: number[];
  /** Carries an offset (a temperature). */
  absolute: boolean;
}

/** Both readings of a byte prefix; every other unit reads the same in both. */
const READINGS = [0, 1] as const;

/**
 * The kinds and factors of a unit text; a text the table does not hold is a kind of its own with the factor 1, so the
 * same text on both sides still adds up and divides out.
 *
 * @param unit the unit text
 * @returns its kinds with their exponents, its factors and its offset
 */
function quantityOf(unit: string): {
  dims: Record<string, number>;
  scales: readonly number[];
  offset?: number;
} {
  const def = definition(unit);
  if (!def) {
    return { dims: { [`"${unit}"`]: 1 }, scales: [1] };
  }
  const dims: Record<string, number> = {};
  const [top, bottom] = def.kind.split("/");
  for (const [kind, by] of [
    [top, 1],
    [bottom, -1],
  ] as const) {
    if (kind !== undefined && kind !== "ratio") {
      dims[kind] = (dims[kind] ?? 0) + by;
    }
  }
  return { dims: withoutZero(dims), scales: def.scales, offset: def.offset };
}

function withoutZero(dims: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(dims).filter(([, n]) => n !== 0));
}

function sameKind(a: Quantity, b: Quantity): boolean {
  const keys = new Set([...Object.keys(a.dims), ...Object.keys(b.dims)]);
  return [...keys].every((k) => a.dims[k] === b.dims[k]);
}

/**
 * Work a term out in its kinds' base units.
 *
 * @param term the term
 * @returns the quantity, or why it cannot be worked out
 */
function evaluate(term: Term): Quantity | string {
  if ("value" in term) {
    const q = quantityOf(term.unit);
    return {
      dims: q.dims,
      values: READINGS.map(
        (r) => term.value * (q.scales[r] ?? q.scales[0] ?? 1) + (q.offset ?? 0),
      ),
      absolute: q.offset !== undefined,
    };
  }
  const parts: Quantity[] = [];
  for (const t of term.terms) {
    const part = evaluate(t);
    if (typeof part === "string") {
      return part;
    }
    parts.push(part);
  }
  const [first, second] = parts;
  if (!first || !second) {
    return `"${term.op}" takes at least two terms`;
  }
  if (parts.some((p) => p.absolute) && term.op !== "mean") {
    return `a temperature only averages — "${term.op}" of one has no unit to convert`;
  }
  const at = (r: number) => (p: Quantity) => p.values[r] ?? 0;
  if (term.op === "quotient") {
    if (READINGS.some((r) => at(r)(second) === 0)) {
      return '"quotient" divides by 0';
    }
    const dims: Record<string, number> = { ...first.dims };
    for (const [k, n] of Object.entries(second.dims)) {
      dims[k] = (dims[k] ?? 0) - n;
    }
    return {
      dims: withoutZero(dims),
      values: READINGS.map((r) => at(r)(first) / at(r)(second)),
      absolute: false,
    };
  }
  // a temperature is the one kind with an offset, so one kind is one way of carrying it
  if (!parts.every((p) => sameKind(p, first))) {
    return `"${term.op}" over values of different kinds`;
  }
  const sum = (r: number): number => parts.reduce((s, p) => s + at(r)(p), 0);
  return {
    dims: first.dims,
    values: READINGS.map((r) =>
      term.op === "difference"
        ? at(r)(first) - at(r)(second)
        : term.op === "mean"
          ? sum(r) / parts.length
          : sum(r),
    ),
    absolute: first.absolute,
  };
}

/**
 * The value of a term in a unit.
 *
 * @param term the computed value
 * @param to the datapoint's `common.unit`
 * @returns every reading of the value in `to` (two where a byte prefix reads both ways), or why it cannot be worked out
 */
export function computeUnit(
  term: Term,
  to: string,
): { readings: number[] } | { fault: string } {
  const q = evaluate(term);
  if (typeof q === "string") {
    return { fault: q };
  }
  const target = quantityOf(to);
  if (!sameKind(q, { dims: target.dims, values: [], absolute: false })) {
    return { fault: `the computed value does not convert to "${to}"` };
  }
  return {
    readings: [
      ...new Set(
        READINGS.map(
          (r) =>
            ((q.values[r] ?? 0) - (target.offset ?? 0)) /
            (target.scales[r] ?? target.scales[0] ?? 1),
        ),
      ),
    ],
  };
}
