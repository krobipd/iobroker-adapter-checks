import { describe, expect, it } from "vitest";
import { computeUnit, convertUnit, type Term } from "./units.js";

const round = (list: number[] | undefined): number[] | undefined =>
  list?.map((v) => Number(v.toPrecision(6)));

describe("convertUnit", () => {
  it("keeps a value whose unit text is the same on both sides, also one the table does not hold", () => {
    expect(convertUnit(-42, "dBm", "dBm")).toEqual([-42]);
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
  });
  it("refuses two kinds in a sum, mean or difference, a temperature outside a mean and a division by 0", () => {
    for (const op of ["sum", "mean", "difference"] as const) {
      expect(readings({ op, terms: [n(1, "s"), n(1, "MB")] }, "s")).toBe(
        `"${op}" over values of different kinds`,
      );
    }
    for (const op of ["sum", "difference", "quotient"] as const) {
      expect(readings({ op, terms: [n(20, "°C"), n(10, "°C")] }, "°C")).toBe(
        `a temperature only averages — "${op}" of one has no unit to convert`,
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
      'a temperature only averages — "difference" of one has no unit to convert',
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
  it("refuses a result of another kind than the datapoint's unit", () => {
    expect(
      readings({ op: "quotient", terms: [n(1000, "B"), n(20, "B/s")] }, "MB/s"),
    ).toBe('the computed value does not convert to "MB/s"');
    expect(readings({ op: "sum", terms: [n(1, "s"), n(1, "s")] }, "foo")).toBe(
      'the computed value does not convert to "foo"',
    );
  });
});
