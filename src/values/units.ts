/**
 * Unit conversion for the `unit-value` rule: a number a program or device recorded in its own unit, converted to the
 * datapoint's `common.unit`. ioBroker gives `common.unit` as free text ("the unit of the value", objectsschema.md, state
 * `common.unit`), so the table holds the units the role catalog and the fleet use; two units it cannot relate are no
 * conversion, and the same text on both sides is always the identity.
 *
 * A byte prefix without "i" (`kB`, `MB`, `GB`, `TB`, also in a rate) is read as 1000 or 1024 — both are in use for the same
 * text, and a value only has to fit one of them; `KiB`, `MiB`, … are binary only.
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
