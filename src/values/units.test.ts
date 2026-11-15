import { describe, expect, it } from "vitest";
import { convertUnit } from "./units.js";

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
