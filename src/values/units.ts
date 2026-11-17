/**
 * The unit knowledge of the checks: a unit text read into its dimensions and its factor to the coherent unit, so any two
 * texts of one quantity convert. ioBroker gives `common.unit` as free text ("the unit of the value", objectsschema.md,
 * state `common.unit`) and keeps no table of its own, so a text is read by the rules of its standards, never looked up in
 * a list of the units somebody met:
 *
 * - the SI units with every SI prefix (SI Brochure, 9th edition: the seven base units, the 22 derived units with special
 *   names, the prefixes from quecto to quetta) and the non-SI units accepted for use with the SI (min, h, d, °, ha, l, t,
 *   eV), beside the usual units of the fleet's devices (bar, °F, kn, mph, rpm, psi, mmHg, cal, …);
 * - bit and byte with the decimal and the binary prefixes (IEC 80000-13) — a decimal prefix on a byte (`kB`, `MB`, also
 *   `KB`) is read as 1000 or 1024, both are in use for the same text and a value only has to fit one of them; `KiB`, `MiB`, …
 *   are binary only, a bit takes a decimal prefix as 1000;
 * - shares down to parts per trillion (%, ‰, ‱, ppm, ppb, ppt);
 * - temperatures with their zero point (°C, °F, K) — an offset only where the text is the temperature alone;
 * - products (`kWh`, `N·m`, `kVarh`), quotients (`MB/s`, `µg/m³`) and powers (`m²`, `m3`, `s^-1`) of all of these;
 * - the level units dB and dBm and every currency (an ISO 4217 code, `€`, `$`, `£`) — each converts only to itself.
 *
 * Quantities the SI writes alike but keeps apart in use stay apart: apparent (VA) and reactive power (var) next to W,
 * becquerel next to hertz, gray and sievert next to J/kg, an angle (rad, °) next to a share, a revolution per minute as an
 * angular velocity next to hertz. Two texts that do not read into one quantity are no conversion, a text these rules do
 * not read is no unit — the same text on both sides is always the identity.
 *
 * A value the adapter computes from several recorded numbers (a share of two, a time left from three, a sum over programs)
 * is a {@link Term}: {@link computeUnit} works it out in the coherent units and converts the result. Kinds follow the
 * operation — a sum, mean, difference, least or greatest value keeps one kind, a product multiplies and a quotient divides
 * them (bytes by bytes per second is a time, bytes by bytes a share, a size times a share a size) — and an absolute
 * temperature only averages or gives its least or greatest value.
 */

/** Exponent per dimension; empty for a pure number (a share). */
type Dims = Record<string, number>;

/** A unit text read. */
interface UnitDef {
  dims: Dims;
  /** The factor to the coherent unit, once per reading of a byte prefix (decimal, binary); the same twice otherwise. */
  scales: readonly [number, number];
  /** Added after scaling — an absolute temperature only. */
  offset?: number;
}

/** Which prefixes a unit takes. */
type PrefixClass = "si" | "data" | "none";

interface Base {
  dims: Dims;
  factor: number;
  prefixes: PrefixClass;
  offset?: number;
}

const base = (
  dims: Dims,
  factor = 1,
  prefixes: PrefixClass = "si",
  offset?: number,
): Base => ({ dims, factor, prefixes, offset });

const ENERGY: Dims = { mass: 1, length: 2, time: -2 };
const POWER: Dims = { mass: 1, length: 2, time: -3 };
const PRESSURE: Dims = { mass: 1, length: -1, time: -2 };
const VOLUME: Dims = { length: 3 };
const SPEED: Dims = { length: 1, time: -1 };
const TEMPERATURE: Dims = { temperature: 1 };

/** The units by symbol — SI Brochure tables 2, 4 and 8, IEC 80000-13, and the usual units beside them. */
const UNITS: Record<string, Base> = {
  // SI base units (the kilogram is a prefixed gram)
  m: base({ length: 1 }),
  g: base({ mass: 1 }, 0.001),
  s: base({ time: 1 }),
  A: base({ current: 1 }),
  K: base(TEMPERATURE, 1, "none", -273.15),
  mol: base({ amount: 1 }),
  cd: base({ luminosity: 1 }),
  // SI derived units with special names
  rad: base({ angle: 1 }),
  sr: base({ angle: 2 }),
  Hz: base({ time: -1 }),
  N: base({ mass: 1, length: 1, time: -2 }),
  Pa: base(PRESSURE),
  J: base(ENERGY),
  W: base(POWER),
  C: base({ current: 1, time: 1 }),
  V: base({ mass: 1, length: 2, time: -3, current: -1 }),
  F: base({ mass: -1, length: -2, time: 4, current: 2 }),
  Ω: base({ mass: 1, length: 2, time: -3, current: -2 }),
  Ohm: base({ mass: 1, length: 2, time: -3, current: -2 }),
  S: base({ mass: -1, length: -2, time: 3, current: 2 }),
  Wb: base({ mass: 1, length: 2, time: -2, current: -1 }),
  T: base({ mass: 1, time: -2, current: -1 }),
  H: base({ mass: 1, length: 2, time: -2, current: -2 }),
  "°C": base(TEMPERATURE, 1, "none", 0),
  "℃": base(TEMPERATURE, 1, "none", 0),
  lm: base({ luminosity: 1 }),
  lx: base({ luminosity: 1, length: -2 }),
  lux: base({ luminosity: 1, length: -2 }),
  Bq: base({ decay: 1 }),
  Gy: base({ absorbed: 1 }),
  Sv: base({ equivalent: 1 }),
  kat: base({ amount: 1, time: -1 }),
  // non-SI units accepted for use with the SI
  min: base({ time: 1 }, 60, "none"),
  h: base({ time: 1 }, 3600, "none"),
  d: base({ time: 1 }, 86400, "none"),
  "°": base({ angle: 1 }, Math.PI / 180, "none"),
  ha: base({ length: 2 }, 1e4, "none"),
  l: base(VOLUME, 0.001),
  L: base(VOLUME, 0.001),
  t: base({ mass: 1 }, 1000, "none"),
  eV: base(ENERGY, 1.602176634e-19),
  // usual units beside them
  bar: base(PRESSURE, 1e5),
  psi: base(PRESSURE, 6894.757293168, "none"),
  mmHg: base(PRESSURE, 133.322387415, "none"),
  inHg: base(PRESSURE, 3386.389, "none"),
  "°F": base(TEMPERATURE, 5 / 9, "none", -160 / 9),
  "℉": base(TEMPERATURE, 5 / 9, "none", -160 / 9),
  rpm: base({ angle: 1, time: -1 }, (2 * Math.PI) / 60, "none"),
  kn: base(SPEED, 1852 / 3600, "none"),
  mph: base(SPEED, 0.44704, "none"),
  in: base({ length: 1 }, 0.0254, "none"),
  ft: base({ length: 1 }, 0.3048, "none"),
  yd: base({ length: 1 }, 0.9144, "none"),
  mi: base({ length: 1 }, 1609.344, "none"),
  gal: base(VOLUME, 0.003785411784, "none"),
  lb: base({ mass: 1 }, 0.45359237, "none"),
  oz: base({ mass: 1 }, 0.028349523125, "none"),
  cal: base(ENERGY, 4.184),
  Btu: base(ENERGY, 1055.05585262, "none"),
  VA: base({ apparent: 1 }),
  var: base({ reactive: 1 }),
  Var: base({ reactive: 1 }),
  VAr: base({ reactive: 1 }),
  VAR: base({ reactive: 1 }),
  // information (IEC 80000-13)
  B: base({ data: 1 }, 1, "data"),
  bit: base({ data: 1 }, 1 / 8, "data"),
  b: base({ data: 1 }, 1 / 8, "data"),
  // shares
  ratio: base({}, 1, "none"),
  "%": base({}, 0.01, "none"),
  "‰": base({}, 1e-3, "none"),
  "‱": base({}, 1e-4, "none"),
  ppm: base({}, 1e-6, "none"),
  ppb: base({}, 1e-9, "none"),
  ppt: base({}, 1e-12, "none"),
  // levels — each only in itself
  dB: base({ dB: 1 }, 1, "none"),
  dBm: base({ dBm: 1 }, 1, "none"),
};

/** SI prefixes (SI Brochure table 7). */
const SI_PREFIXES: Record<string, number> = {
  Q: 1e30,
  R: 1e27,
  Y: 1e24,
  Z: 1e21,
  E: 1e18,
  P: 1e15,
  T: 1e12,
  G: 1e9,
  M: 1e6,
  k: 1e3,
  h: 1e2,
  da: 1e1,
  d: 1e-1,
  c: 1e-2,
  m: 1e-3,
  µ: 1e-6,
  μ: 1e-6,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
  a: 1e-18,
  z: 1e-21,
  y: 1e-24,
  r: 1e-27,
  q: 1e-30,
};

/** The decimal prefixes of information by power of 1000 (`K` is a kilo of bytes in use too). */
const DATA_PREFIXES: Record<string, number> = {
  k: 1,
  K: 1,
  M: 2,
  G: 3,
  T: 4,
  P: 5,
  E: 6,
  Z: 7,
  Y: 8,
};

/** The binary prefixes (IEC 80000-13) by power of 1024. */
const BINARY_PREFIXES: Record<string, number> = {
  Ki: 1,
  Mi: 2,
  Gi: 3,
  Ti: 4,
  Pi: 5,
  Ei: 6,
  Zi: 7,
  Yi: 8,
};

/**
 * Whole texts the role catalog (ioBroker.docs `docs/en/dev/stateroles.md`) writes in a form of its own, with every
 * reading: `mgdl` at `value.blood.sugar`, `m` for minutes at `value.interval` beside the metre, `lbs` at
 * `value.health.weight`. The other side of a conversion picks the reading of its kind.
 */
const CATALOG_SPELLINGS: Record<string, readonly string[]> = {
  mgdl: ["mg/dL"],
  m: ["m", "min"],
  lbs: ["lb"],
};

/** Currency signs and their ISO 4217 codes. */
const CURRENCY_SIGNS: Record<string, string> = {
  "€": "EUR",
  $: "USD",
  "£": "GBP",
};

const SUPERSCRIPT: Record<string, string> = {
  "⁻": "-",
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
};

const FACTOR_RE = /^(.*?)(?:\^(-?\d+)|([⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+)|(\d+))?$/u;

/**
 * A unit as it stands under a symbol.
 *
 * @param b the unit
 * @param prefix its prefix factor, once per reading
 * @returns its definition
 */
function fromBase(
  b: Base,
  prefix: readonly [number, number] = [1, 1],
): UnitDef {
  return {
    dims: { ...b.dims },
    scales: [b.factor * prefix[0], b.factor * prefix[1]],
    offset: b.offset,
  };
}

/**
 * A symbol, with a prefix where its unit takes one.
 *
 * @param text the symbol
 * @returns its definition, or undefined
 */
function prefixed(text: string): UnitDef | undefined {
  const direct = UNITS[text];
  if (direct) {
    return fromBase(direct);
  }
  for (const [prefix, power] of Object.entries(BINARY_PREFIXES)) {
    const unit = text.startsWith(prefix)
      ? UNITS[text.slice(prefix.length)]
      : undefined;
    if (unit?.prefixes === "data") {
      return fromBase(unit, [1024 ** power, 1024 ** power]);
    }
  }
  for (const [prefix, factor] of Object.entries(SI_PREFIXES)) {
    const unit = text.startsWith(prefix)
      ? UNITS[text.slice(prefix.length)]
      : undefined;
    if (unit?.prefixes === "si") {
      return fromBase(unit, [factor, factor]);
    }
  }
  for (const [prefix, power] of Object.entries(DATA_PREFIXES)) {
    const unit = text.startsWith(prefix)
      ? UNITS[text.slice(prefix.length)]
      : undefined;
    if (unit?.prefixes === "data") {
      // a byte reads a decimal prefix both ways; a bit, counted on lines that run at decimal rates, as 1000
      const binary = unit.factor === 1 ? 1024 ** power : 1000 ** power;
      return fromBase(unit, [1000 ** power, binary]);
    }
  }
  return undefined;
}

/**
 * A symbol: one with or without its prefix, a currency, or two or three symbols written together (`kWh`, `Nm`, `kVarh`).
 *
 * @param text the symbol
 * @returns its definition, or undefined
 */
function symbol(text: string): UnitDef | undefined {
  const one = prefixed(text);
  if (one) {
    return one;
  }
  const code =
    CURRENCY_SIGNS[text] ?? (/^[A-Z]{3}$/.test(text) ? text : undefined);
  if (code) {
    return { dims: { [`currency ${code}`]: 1 }, scales: [1, 1] };
  }
  return together(text, 3);
}

/**
 * Symbols written together, the longest first symbol first.
 *
 * @param text the symbols
 * @param parts how many symbols at most
 * @returns their product, or undefined
 */
function together(text: string, parts: number): UnitDef | undefined {
  if (parts < 2) {
    return undefined;
  }
  for (let cut = text.length - 1; cut > 0; cut--) {
    const head = prefixed(text.slice(0, cut));
    const rest = text.slice(cut);
    const tail = head
      ? (prefixed(rest) ?? together(rest, parts - 1))
      : undefined;
    if (head && tail) {
      return times(head, tail, 1);
    }
  }
  return undefined;
}

/**
 * Multiply a unit by another raised to a power.
 *
 * @param a the unit
 * @param b the other
 * @param power the power of the other
 * @returns the product, without an offset
 */
function times(a: UnitDef, b: UnitDef, power: number): UnitDef {
  const dims: Dims = { ...a.dims };
  for (const [k, n] of Object.entries(b.dims)) {
    dims[k] = (dims[k] ?? 0) + n * power;
  }
  return {
    dims: withoutZero(dims),
    scales: [
      a.scales[0] * b.scales[0] ** power,
      a.scales[1] * b.scales[1] ** power,
    ],
  };
}

/**
 * One factor of a product: a symbol with its power.
 *
 * @param text the factor
 * @returns the unit and its power, or undefined
 */
function factor(text: string): { unit: UnitDef; power: number } | undefined {
  const m = FACTOR_RE.exec(text);
  const name = m?.[1] ?? "";
  const written =
    m?.[2] ?? [...(m?.[3] ?? "")].map((c) => SUPERSCRIPT[c] ?? "").join("");
  const power = written === "" ? Number(m?.[4] ?? 1) : Number(written);
  const unit = name === "" ? undefined : symbol(name);
  if (unit && Number.isInteger(power) && power !== 0) {
    return { unit, power };
  }
  // a digit that belongs to the symbol, never a power of it
  const whole = symbol(text);
  return whole ? { unit: whole, power: 1 } : undefined;
}

/**
 * Every reading of a unit text: one, two for a catalog spelling with two meanings, none for a text the rules do not read.
 *
 * @param unit the unit text
 * @returns its definitions
 */
function definitions(unit: string): UnitDef[] {
  const raw = unit.trim();
  return (CATALOG_SPELLINGS[raw] ?? [raw])
    .map(definition)
    .filter((d): d is UnitDef => d !== undefined);
}

/**
 * Read one unit text.
 *
 * @param raw the unit text
 * @returns its definition, or undefined for a text the rules do not read
 */
function definition(raw: string): UnitDef | undefined {
  // bits per second written as one word (`kbps`, `Mbps`)
  const words = /^(.*)bps$/.exec(raw);
  const text = words ? `${words[1] ?? ""}bit/s` : raw;
  if (text === "") {
    return undefined;
  }
  const alone = UNITS[text];
  if (alone?.offset !== undefined) {
    return fromBase(alone);
  }
  let result: UnitDef = { dims: {}, scales: [1, 1] };
  const sides = text.split("/");
  for (const [i, side] of sides.entries()) {
    if (side === "1" && i === 0 && sides.length > 1) {
      continue;
    }
    const factors = side.split(/[·⋅*\s]+/u);
    if (side === "" || factors.some((f) => f === "")) {
      return undefined;
    }
    for (const f of factors) {
      const read = factor(f);
      if (!read) {
        return undefined;
      }
      result = times(result, read.unit, i === 0 ? read.power : -read.power);
    }
  }
  return result;
}

/**
 * The quantities a unit text measures, as one text per kind: two unit texts convert when they share one. An empty text
 * is a share; a catalog spelling with two meanings has two.
 *
 * @param unit the unit text
 * @returns the kinds, none for a text the rules do not read
 */
export function unitKinds(unit: string): string[] {
  return [...new Set(definitions(unit).map((d) => kindOf(d.dims)))];
}

/** Both readings of a byte prefix; every other unit reads the same in both. */
const READINGS = [0, 1] as const;

function kindOf(dims: Dims): string {
  return Object.keys(dims)
    .sort()
    .map((k) => (dims[k] === 1 ? k : `${k}^${dims[k]}`))
    .join("·");
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
  const out = new Set<number>();
  for (const a of definitions(from)) {
    for (const b of definitions(to)) {
      if (kindOf(a.dims) !== kindOf(b.dims)) {
        continue;
      }
      // two texts read both ways are read the same way on both sides (2 GB is 2000 MB or 2048 MB, never 2147 MB)
      for (const r of READINGS) {
        out.add(
          (value * a.scales[r] + (a.offset ?? 0) - (b.offset ?? 0)) /
            b.scales[r],
        );
      }
    }
  }
  return out.size > 0 ? [...out] : undefined;
}

/** The operations of a computed value. */
export const OPERATIONS = [
  "sum",
  "mean",
  "difference",
  "quotient",
  "product",
  "min",
  "max",
] as const;
export type Operation = (typeof OPERATIONS)[number];

/** The operations that keep an absolute temperature: its mean, its least and its greatest value. */
const KEEP_TEMPERATURE: readonly Operation[] = ["mean", "min", "max"];

/** A computed value: a recorded number in its unit, or an operation over such terms. */
export type Term =
  | { readonly value: number; readonly unit: string }
  | { readonly op: Operation; readonly terms: readonly Term[] };

/** A value on its way through a {@link Term}. */
interface Quantity {
  /** Exponent per dimension; empty for a share. */
  dims: Dims;
  /** The value in the coherent unit, once per reading of a byte prefix (decimal, binary). */
  values: number[];
  /** Carries an offset (an absolute temperature). */
  absolute: boolean;
}

/**
 * The readings of a unit text; a text the rules do not read is a kind of its own with the factor 1, so the same text on
 * both sides still adds up and divides out.
 *
 * @param unit the unit text
 * @returns its definitions, at least one
 */
function quantitiesOf(unit: string): UnitDef[] {
  const read = definitions(unit);
  return read.length > 0
    ? read
    : [{ dims: { [`"${unit}"`]: 1 }, scales: [1, 1] }];
}

function withoutZero(dims: Dims): Dims {
  return Object.fromEntries(Object.entries(dims).filter(([, n]) => n !== 0));
}

function sameKind(a: Dims, b: Dims): boolean {
  return kindOf(a) === kindOf(b);
}

/**
 * Work a term out in the coherent units.
 *
 * @param term the term
 * @returns the quantity, or why it cannot be worked out
 */
function evaluate(term: Term): Quantity | string {
  if ("value" in term) {
    // a recorded number reads its unit in the first meaning (`m` is a metre); the datapoint's unit takes every one
    const [q] = quantitiesOf(term.unit) as [UnitDef];
    return {
      dims: q.dims,
      values: READINGS.map((r) => term.value * q.scales[r] + (q.offset ?? 0)),
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
  if (parts.some((p) => p.absolute) && !KEEP_TEMPERATURE.includes(term.op)) {
    return `an absolute temperature only averages or gives its least or greatest value — "${term.op}" of one has no unit to convert`;
  }
  const at = (r: number) => (p: Quantity) => p.values[r] ?? 0;
  if (term.op === "quotient" || term.op === "product") {
    const by = term.op === "quotient" ? -1 : 1;
    if (by < 0 && READINGS.some((r) => at(r)(second) === 0)) {
      return '"quotient" divides by 0';
    }
    const factors = by < 0 ? [first, second] : parts;
    const dims: Dims = {};
    for (const [i, p] of factors.entries()) {
      for (const [k, n] of Object.entries(p.dims)) {
        dims[k] = (dims[k] ?? 0) + (i === 0 ? n : n * by);
      }
    }
    return {
      dims: withoutZero(dims),
      values: READINGS.map((r) =>
        by < 0
          ? at(r)(first) / at(r)(second)
          : parts.reduce((v, p) => v * at(r)(p), 1),
      ),
      absolute: false,
    };
  }
  // a temperature is the one kind with an offset, so one kind is one way of carrying it
  if (!parts.every((p) => sameKind(p.dims, first.dims))) {
    return `"${term.op}" over values of different kinds`;
  }
  const sum = (r: number): number => parts.reduce((s, p) => s + at(r)(p), 0);
  const value = (r: number): number => {
    const all = parts.map(at(r));
    switch (term.op) {
      case "difference":
        return at(r)(first) - at(r)(second);
      case "mean":
        return sum(r) / parts.length;
      case "min":
        return Math.min(...all);
      case "max":
        return Math.max(...all);
      default:
        return sum(r);
    }
  };
  return {
    dims: first.dims,
    values: READINGS.map(value),
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
  const targets = quantitiesOf(to).filter((t) => sameKind(q.dims, t.dims));
  if (targets.length === 0) {
    return { fault: `the computed value does not convert to "${to}"` };
  }
  return {
    readings: [
      ...new Set(
        targets.flatMap((t) =>
          READINGS.map(
            (r) => ((q.values[r] ?? 0) - (t.offset ?? 0)) / t.scales[r],
          ),
        ),
      ),
    ],
  };
}
