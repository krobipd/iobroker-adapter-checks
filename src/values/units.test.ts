import { describe, expect, it } from "vitest";
import { runUnits, UNITS_USAGE } from "./cli.js";
import { computeUnit, convertUnit, unitKinds, type Term } from "./units.js";

const round = (list: number[] | undefined): number[] | undefined =>
  list?.map((v) => Number(v.toPrecision(6)));

/** Every unit the role catalog names (ioBroker.docs stateroles.md, 2026-11-16: each "unit: …", "unit=…", "common.unit=…"). */
const CATALOG_UNITS = [
  "%",
  "A",
  "Bq/m³",
  "Hz",
  "K",
  "V",
  "W",
  "Wh",
  "Ws",
  "d",
  "dBm",
  "g/m³",
  "h",
  "hPa",
  "kVar",
  "kVarh",
  "kW",
  "kWh",
  "l",
  "lux",
  "m",
  "m3",
  "mbar",
  "mg/m³",
  "mgdl",
  "ml",
  "mm",
  "mmol",
  "ms",
  "m³",
  "m³/h",
  "ppb",
  "ppm",
  "s",
  "var",
  "vars",
  "°C",
  "°F",
  "µg/m³",
];
/** Every unit of the inventories of thirteen adapters (2026-11-17, each repository's committed objects.inventory.json). */
const FLEET_UNITS = [
  "%",
  "USD",
  "s",
  "MB/s",
  "GB",
  "MB",
  "W",
  "B/s",
  "ms",
  "rpm",
  "h",
  "°C",
  "K",
  "ppm",
  "min",
  "ml",
  "kg",
  "l",
  "kWh",
  "dBm",
  "A",
  "Hz",
  "V",
  "VA",
  "var",
  "m3",
  "°",
  "Ah",
  "d",
  "kbps",
  "kHz",
  "dB",
];
/** The SI prefixes (SI Brochure, 9th edition, table 7) with their factors. */
const SI_PREFIX_FACTORS: [string, number][] = [
  ["q", 1e-30],
  ["r", 1e-27],
  ["y", 1e-24],
  ["z", 1e-21],
  ["a", 1e-18],
  ["f", 1e-15],
  ["p", 1e-12],
  ["n", 1e-9],
  ["µ", 1e-6],
  ["μ", 1e-6],
  ["m", 1e-3],
  ["c", 1e-2],
  ["d", 1e-1],
  ["da", 1e1],
  ["h", 1e2],
  ["k", 1e3],
  ["M", 1e6],
  ["G", 1e9],
  ["T", 1e12],
  ["P", 1e15],
  ["E", 1e18],
  ["Z", 1e21],
  ["Y", 1e24],
  ["R", 1e27],
  ["Q", 1e30],
];
const close = (got: number[] | undefined, want: number[]): void => {
  expect(got?.length).toBe(want.length);
  want.forEach((w, i) =>
    expect(Math.abs((got?.[i] ?? NaN) - w)).toBeLessThanOrEqual(
      Math.abs(w) * 1e-9,
    ),
  );
};

describe("unitKinds", () => {
  it("reads every unit the role catalog and the fleet write", () => {
    const unread = [...CATALOG_UNITS, ...FLEET_UNITS].filter(
      (u) => unitKinds(u).length === 0,
    );
    expect(unread).toEqual([]);
  });
  it("gives every spelling of one quantity the same kind", () => {
    const same = [
      ["lux", "lx"],
      ["m3", "m³", "l", "ml"],
      ["kVar", "var", "VAr"],
      ["kVarh", "vars"],
      ["Ws", "Wh", "kWh", "J"],
      ["mgdl", "mg/m³", "µg/m³", "g/m³"],
      ["Hz", "kHz", "s^-1", "s⁻¹"],
      ["°C", "°F", "K", "℃"],
      ["kbps", "bit/s", "MB/s"],
    ];
    for (const group of same) {
      expect(new Set(group.map((u) => unitKinds(u).join("|"))).size).toBe(1);
    }
  });
  it("gives the catalog's minute written as m both meanings and a text the rules do not read none", () => {
    expect(unitKinds("m").sort()).toEqual(
      [...unitKinds("min"), ...unitKinds("km")].sort(),
    );
    for (const text of ["foo", "days", "pcs", ""]) {
      expect(unitKinds(text)).toEqual([]);
    }
  });
  it("reads up to three symbols written together and no more", () => {
    expect(unitKinds("Wsh")).toEqual(unitKinds("W·s·h"));
    expect(unitKinds("Wsh")).not.toEqual([]);
    expect(unitKinds("Wsht")).toEqual([]);
  });
});

describe("the units command", () => {
  it("prints each given unit text with its kinds as one JSON object", () => {
    const lines: string[] = [];
    expect(runUnits(["kW", "foo"], (l) => lines.push(l))).toBe(0);
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { kW: unitKinds("W"), foo: [] },
    ]);
  });
  it("ends with 2 and its usage without a unit", () => {
    const lines: string[] = [];
    expect(runUnits([], (l) => lines.push(l))).toBe(2);
    expect(lines).toEqual([UNITS_USAGE]);
    expect(UNITS_USAGE).toMatch(/^usage: iobroker-adapter-checks units <unit>/);
  });
});

describe("convertUnit across the standards", () => {
  it("converts with every SI prefix", () => {
    for (const [prefix, factor] of SI_PREFIX_FACTORS) {
      close(convertUnit(1, `${prefix}m`, "m"), [factor]);
    }
  });
  it("reads the binary prefixes one way, a decimal prefix on a byte both ways and on a bit as 1000", () => {
    ["Ki", "Mi", "Gi", "Ti", "Pi", "Ei", "Zi", "Yi"].forEach((p, i) =>
      close(convertUnit(1, `${p}B`, "B"), [1024 ** (i + 1)]),
    );
    close(convertUnit(1, "TB", "B"), [1e12, 1024 ** 4]);
    close(convertUnit(1, "KB", "B"), [1000, 1024]);
    close(convertUnit(1, "Mbit", "bit"), [1e6]);
    close(convertUnit(1, "kb", "bit"), [1000]);
    close(convertUnit(1, "MiB", "Mbit"), [8 * 1.048576]);
  });
  it("converts shares down to parts per trillion", () => {
    close(convertUnit(1, "%", "ppm"), [1e4]);
    close(convertUnit(1, "‰", "%"), [0.1]);
    close(convertUnit(1, "‱", "ppm"), [100]);
    close(convertUnit(1, "ppb", "ppt"), [1000]);
    close(convertUnit(1, "ratio", "‰"), [1000]);
  });
  it("converts products, quotients and powers", () => {
    close(convertUnit(1, "m3", "l"), [1000]);
    close(convertUnit(1, "m²", "cm2"), [1e4]);
    close(convertUnit(1, "N·m", "J"), [1]);
    close(convertUnit(1, "kWh", "J"), [3.6e6]);
    close(convertUnit(1, "s^-1", "Hz"), [1]);
    close(convertUnit(1, "mg/m³", "µg/m³"), [1000]);
    close(convertUnit(1, "m³/h", "l/min"), [1000 / 60]);
    close(convertUnit(1, "kVarh", "vars"), [3.6e6]);
    close(convertUnit(1, "mgdl", "mg/l"), [10]);
    close(convertUnit(1, "€/kWh", "€/Wh"), [0.001]);
    close(convertUnit(1, "lbs", "kg"), [0.45359237]);
  });
  it("lets the other side pick the meaning of the catalog's m", () => {
    close(convertUnit(90, "s", "m"), [1.5]);
    close(convertUnit(150, "cm", "m"), [1.5]);
  });
  it("keeps levels, currencies, apparent and reactive power, activity and angles each in itself", () => {
    for (const [a, b] of [
      ["dBm", "dB"],
      ["dB", "%"],
      ["USD", "EUR"],
      ["VA", "W"],
      ["var", "W"],
      ["Bq", "Hz"],
      ["rpm", "Hz"],
      ["°", "%"],
      ["days", "d"],
    ]) {
      expect(convertUnit(1, a ?? "", b ?? "")).toBeUndefined();
    }
    close(convertUnit(1, "EUR", "€"), [1]);
    close(convertUnit(60, "rpm", "rad/s"), [2 * Math.PI]);
    close(convertUnit(180, "°", "rad"), [Math.PI]);
  });
});

describe("convertUnit", () => {
  it("keeps a value whose unit text is the same on both sides, also one the table does not hold", () => {
    expect(convertUnit(-42, "dBm", "dBm")).toEqual([-42]);
    expect(convertUnit(7, "pcs", "pcs")).toEqual([7]);
  });
  it("reads a byte prefix without i both ways and a binary prefix one way", () => {
    expect(round(convertUnit(102400, "B/s", "MB/s"))).toEqual([
      0.1024, 0.0976563,
    ]);
    expect(round(convertUnit(102400, "KiB/s", "MB/s"))).toEqual([104.858, 100]);
    expect(round(convertUnit(1, "MiB", "KiB"))).toEqual([1024]);
    expect(round(convertUnit(2, "GB", "MB"))).toEqual([2000, 2048]);
  });
  it("converts bits per second written as one word", () => {
    expect(round(convertUnit(8, "kbps", "B/s"))).toEqual([1000]);
  });
  it("converts time, power, energy, voltage, current, charge, frequency, volume, mass and length within their kind", () => {
    expect(round(convertUnit(90, "s", "min"))).toEqual([1.5]);
    expect(round(convertUnit(2, "h", "s"))).toEqual([7200]);
    expect(round(convertUnit(1500, "Wh", "kWh"))).toEqual([1.5]);
    expect(round(convertUnit(1.2, "kW", "W"))).toEqual([1200]);
    expect(round(convertUnit(230000, "mV", "V"))).toEqual([230]);
    expect(round(convertUnit(500, "mA", "A"))).toEqual([0.5]);
    expect(round(convertUnit(2000, "mAh", "Ah"))).toEqual([2]);
    expect(round(convertUnit(44100, "Hz", "kHz"))).toEqual([44.1]);
    expect(round(convertUnit(250, "ml", "l"))).toEqual([0.25]);
    expect(round(convertUnit(1.5, "kg", "g"))).toEqual([1500]);
    expect(round(convertUnit(120, "cm", "m"))).toEqual([1.2]);
    expect(round(convertUnit(1.2, "kVA", "VA"))).toEqual([1200]);
    expect(round(convertUnit(800, "var", "kvar"))).toEqual([0.8]);
  });
  it("divides a rate by its time, so another time below the line converts too", () => {
    expect(round(convertUnit(36, "km/h", "m/s"))).toEqual([10]);
    expect(round(convertUnit(1, "kWh/min", "kWh/h"))).toEqual([60]);
  });
  it("converts temperatures with their offset", () => {
    expect(round(convertUnit(68, "°F", "°C"))).toEqual([20]);
    expect(round(convertUnit(293.15, "K", "°C"))).toEqual([20]);
    expect(round(convertUnit(20, "°C", "°F"))).toEqual([68]);
  });
  it("converts a share to percent", () => {
    expect(round(convertUnit(0.5, "ratio", "%"))).toEqual([50]);
  });
  it("relates no two kinds and no text the table does not hold", () => {
    expect(convertUnit(1, "s", "MB")).toBeUndefined();
    expect(convertUnit(1, "B/s", "MB")).toBeUndefined();
    expect(convertUnit(1, "foo", "bar")).toBeUndefined();
    expect(convertUnit(1, "foo/s", "MB/s")).toBeUndefined();
    expect(convertUnit(1, "MB/foo", "MB/s")).toBeUndefined();
    expect(convertUnit(1, "m²", "m")).toBeUndefined();
  });
});

describe("computeUnit", () => {
  const n = (value: number, unit: string): Term => ({ value, unit });
  const readings = (term: Term, to: string): number[] | string => {
    const result = computeUnit(term, to);
    return "fault" in result ? result.fault : (round(result.readings) ?? []);
  };

  it("divides bytes by bytes into a share, reading a byte prefix the same way in every term", () => {
    expect(
      readings({ op: "quotient", terms: [n(512, "MB"), n(1, "GB")] }, "%"),
    ).toEqual([51.2, 50]);
    expect(
      readings({ op: "sum", terms: [n(1, "GB"), n(1, "GB")] }, "MB"),
    ).toEqual([2000, 2048]);
  });
  it("divides what is left by the rate into a time", () => {
    expect(
      readings(
        {
          op: "quotient",
          terms: [
            { op: "difference", terms: [n(1000, "B"), n(400, "B")] },
            n(20, "B/s"),
          ],
        },
        "min",
      ),
    ).toEqual([0.5]);
  });
  it("adds rates of one kind and converts the sum", () => {
    expect(
      readings(
        { op: "sum", terms: [n(102400, "B/s"), n(51200, "B/s")] },
        "MB/s",
      ),
    ).toEqual([0.1536, 0.146484]);
  });
  it("averages temperatures with their offset", () => {
    expect(
      readings(
        { op: "mean", terms: [n(68, "°F"), n(20, "°C"), n(293.15, "K")] },
        "°C",
      ),
    ).toEqual([20]);
    expect(
      readings({ op: "mean", terms: [n(20, "°C"), n(30, "°C")] }, "°F"),
    ).toEqual([77]);
  });
  it("takes a text the table does not hold as a kind of its own", () => {
    expect(
      readings({ op: "sum", terms: [n(3, "pcs"), n(4, "pcs")] }, "pcs"),
    ).toEqual([7]);
    expect(
      readings({ op: "quotient", terms: [n(3, "pcs"), n(4, "pcs")] }, "%"),
    ).toEqual([75]);
    expect(readings({ op: "sum", terms: [n(3, "pcs"), n(4, "W")] }, "W")).toBe(
      '"sum" over values of different kinds',
    );
    expect(
      readings({ op: "sum", terms: [n(3, "pcs"), n(1, "ratio")] }, "pcs"),
    ).toBe('"sum" over values of different kinds');
  });
  it("refuses two kinds in a sum, mean or difference, a temperature outside a mean and a division by 0", () => {
    for (const op of ["sum", "mean", "difference"] as const) {
      expect(readings({ op, terms: [n(1, "s"), n(1, "MB")] }, "s")).toBe(
        `"${op}" over values of different kinds`,
      );
    }
    for (const op of ["sum", "difference", "quotient", "product"] as const) {
      expect(readings({ op, terms: [n(20, "°C"), n(10, "°C")] }, "°C")).toBe(
        `an absolute temperature only averages or gives its least or greatest value — "${op}" of one has no unit to convert`,
      );
    }
    expect(
      readings({ op: "mean", terms: [n(20, "°C"), n(10, "K")] }, "°C"),
    ).toEqual([-121.575]);
    const mean = (a: number, b: number): Term => ({
      op: "mean",
      terms: [n(a, "°C"), n(b, "°C")],
    });
    expect(
      readings({ op: "difference", terms: [mean(20, 30), mean(10, 20)] }, "°C"),
    ).toBe(
      'an absolute temperature only averages or gives its least or greatest value — "difference" of one has no unit to convert',
    );
    expect(
      readings({ op: "quotient", terms: [n(1, "MB"), n(0, "B")] }, "%"),
    ).toBe('"quotient" divides by 0');
    expect(
      readings(
        {
          op: "sum",
          terms: [{ op: "quotient", terms: [n(1, "s"), n(0, "s")] }, n(1, "s")],
        },
        "s",
      ),
    ).toBe('"quotient" divides by 0');
    expect(readings({ op: "sum", terms: [n(1, "s")] }, "s")).toBe(
      '"sum" takes at least two terms',
    );
  });
  it("multiplies a size by a share into the size, and kinds by kinds", () => {
    expect(
      readings({ op: "product", terms: [n(4, "GB"), n(0.25, "ratio")] }, "GB"),
    ).toEqual([1]);
    expect(
      readings({ op: "product", terms: [n(1000, "MB"), n(2500, "‱")] }, "MB"),
    ).toEqual([250]);
    expect(
      readings({ op: "product", terms: [n(2, "A"), n(230, "V")] }, "W"),
    ).toEqual([460]);
    expect(
      readings(
        { op: "product", terms: [n(2, "kW"), n(30, "min"), n(1, "ratio")] },
        "kWh",
      ),
    ).toEqual([1]);
    expect(
      readings(
        { op: "product", terms: [n(2, "A"), n(115, "V"), n(2, "h")] },
        "Wh",
      ),
    ).toEqual([460]);
    expect(
      readings({ op: "product", terms: [n(4, "GB"), n(0, "ratio")] }, "GB"),
    ).toEqual([0]);
  });
  it("gives the least and the greatest value of one kind, temperatures with their offset", () => {
    expect(
      readings({ op: "max", terms: [n(68, "°F"), n(25, "°C")] }, "°C"),
    ).toEqual([25]);
    expect(
      readings({ op: "min", terms: [n(68, "°F"), n(25, "°C")] }, "°C"),
    ).toEqual([20]);
    expect(
      readings({ op: "max", terms: [n(1, "GB"), n(900, "MB")] }, "MB"),
    ).toEqual([1000, 1024]);
    expect(readings({ op: "min", terms: [n(1, "s"), n(1, "MB")] }, "s")).toBe(
      '"min" over values of different kinds',
    );
  });
  it("converts a computed value to the meaning of the catalog's m that fits", () => {
    expect(
      readings({ op: "sum", terms: [n(60, "s"), n(30, "s")] }, "m"),
    ).toEqual([1.5]);
  });
  it("reads a recorded number in m as metres", () => {
    expect(
      readings({ op: "sum", terms: [n(1, "m"), n(50, "cm")] }, "cm"),
    ).toEqual([150]);
  });
  it("refuses a result of another kind than the datapoint's unit", () => {
    expect(
      readings({ op: "quotient", terms: [n(1000, "B"), n(20, "B/s")] }, "MB/s"),
    ).toBe('the computed value does not convert to "MB/s"');
    expect(readings({ op: "sum", terms: [n(1, "s"), n(1, "s")] }, "foo")).toBe(
      'the computed value does not convert to "foo"',
    );
  });
});
