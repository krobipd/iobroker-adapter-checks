import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runValues } from "./cli.js";
import { encodedReason, judgeValues, patternMatches, type ValueInput } from "./judge.js";

const NS = "demo.0.";

function state(common: Record<string, unknown>): unknown {
  return { type: "state", common: { read: true, write: false, role: "text", type: "string", ...common }, native: {} };
}

function input(
  objs: Record<string, Record<string, unknown>>,
  vals: Record<string, unknown>,
  extra: Partial<ValueInput> = {},
): ValueInput {
  const objects: Record<string, unknown> = {};
  const states: Record<string, unknown> = {};
  for (const [id, common] of Object.entries(objs)) {
    objects[NS + id] = state(common);
  }
  for (const [id, val] of Object.entries(vals)) {
    states[NS + id] = { val, ack: true };
  }
  return { objects, states, ...extra };
}

const rules = (i: ValueInput): string[] => judgeValues(i).findings.map((f) => `${f.rule} ${f.id}`);

describe("state-list", () => {
  it("accepts a value from the list", () => {
    expect(rules(input({ p: { states: { cotton: "Baumwolle" } } }, { p: "cotton" }))).toEqual([]);
  });
  it("reports a value outside the list (homeconnect selectedProgram: wd45 with a two-program list)", () => {
    expect(rules(input({ p: { states: { cotton: "Baumwolle", eco4060: "Eco 40-60" } } }, { p: "wd45" }))).toEqual([
      "state-list p",
    ]);
  });
  it("reports an empty string that the list does not name", () => {
    expect(rules(input({ p: { states: { cotton: "Baumwolle" } } }, { p: "" }))).toEqual(["state-list p"]);
  });
  it("leaves null alone — no value is not a wrong value", () => {
    expect(rules(input({ p: { states: { cotton: "Baumwolle" } } }, { p: null }))).toEqual([]);
  });
  it("accepts a number inside min/max next to special values", () => {
    const common = { type: "number", role: "value", min: 0, max: 100, states: { 255: "Blink" } };
    expect(rules(input({ n: common }, { n: 42 }))).toEqual([]);
    expect(rules(input({ n: common }, { n: 255 }))).toEqual([]);
    expect(rules(input({ n: common }, { n: 300 }))).toEqual(["state-list n"]);
  });
  it("reports a number that the list does not name when there is no range", () => {
    expect(rules(input({ n: { type: "number", role: "value", states: { 0: "Aus", 1: "Ein" } } }, { n: 2 }))).toEqual([
      "state-list n",
    ]);
  });
});

describe("label-repeats-key", () => {
  it("reports a label that only repeats its value (homeconnect: auto2 = auto2)", () => {
    const f = judgeValues(input({ p: { states: { auto2: "auto2", eco50: "Eco 50 °C" } } }, { p: "eco50" })).findings;
    expect(f.map((x) => x.rule)).toEqual(["label-repeats-key"]);
    expect(f[0]?.message).toContain("auto2");
  });
  it("accepts a real label even when it only differs in case", () => {
    expect(rules(input({ s: { states: { off: "Off" } } }, { s: "off" }), )).toEqual([]);
  });
});

describe("label-language", () => {
  it("reports a translation object as a label — the admin cannot render it", () => {
    expect(rules(input({ m: { states: { a: { en: "A", de: "A" } } } }, { m: "a" }))).toEqual(["label-language m"]);
  });
  it("reports labels that stay the same in the second language (homeconnect: Running)", () => {
    const en = input({ o: { states: { run: "Running", ready: "Ready" } } }, { o: "run" });
    const de = input({ o: { states: { run: "Running", ready: "Bereit" } } }, { o: "run" });
    const f = judgeValues({ ...en, objectsOtherLanguage: de.objects }).findings;
    expect(f.map((x) => `${x.rule} ${x.id}`)).toEqual(["label-language o"]);
    expect(f[0]?.message).toContain("run=Running");
    expect(f[0]?.message).not.toContain("Bereit");
  });
  it("accepts labels without letters (numbers, units) in both languages", () => {
    const i = input({ t: { states: { gc40: "40 °C", e: "1.5 kWh", p: "20 %" } } }, { t: "gc40" });
    expect(rules({ ...i, objectsOtherLanguage: i.objects })).toEqual([]);
  });
  it("still reports rpm — German writes U/min", () => {
    const i = input({ t: { states: { rpm1400: "1400 rpm" } } }, { t: "rpm1400" });
    expect(rules({ ...i, objectsOtherLanguage: i.objects })).toEqual(["label-language t"]);
  });
  it("says it did not judge the rule without a second language", () => {
    const i = input({ o: { states: { run: "Running" } } }, { o: "run" });
    const r = judgeValues(i);
    expect(r.findings).toEqual([]);
    expect(r.notJudged.join()).toContain("label-language");
  });
});

describe("enum-without-list", () => {
  it("reports an identifier value without a list (homeconnect dryingTarget)", () => {
    expect(rules(input({ d: {} }, { d: "cupboarddryplus" }))).toEqual(["enum-without-list d"]);
  });
  it("leaves free text, names and writable states alone", () => {
    expect(rules(input({ a: {}, b: {}, c: { write: true } }, { a: "Unknown", b: "Mein Gerät", c: "fluffing" }))).toEqual([]);
  });
  it("leaves numbers and booleans alone", () => {
    expect(rules(input({ a: { type: "number" }, b: { type: "boolean" } }, { a: 3, b: true }))).toEqual([]);
  });
});

describe("encoded-value", () => {
  it.each([
    ["ewN7B3u2e7Y", "history uid"],
    ["AL0A-QAMAAw", "effective time"],
    ["D3sHAF0AXwANqOA", "program details"],
    ["AEQAGABFAAA", "all upper case, but NUL bytes inside"],
  ])("reports homeconnect's base64 value %s (%s)", (v) => {
    expect(encodedReason(v)).toContain("base64");
  });
  it("reports raw JSON, also an empty list (homeconnect errorCodesList)", () => {
    expect(encodedReason('{"counter":359,"sequence":[{"program":31670}]}')).toContain("JSON");
    expect(encodedReason("[]")).toContain("JSON");
  });
  it("reports a long hex block", () => {
    expect(encodedReason("0f7b8500020000b9dc0a")).toContain("hex");
  });
  it.each([
    "1Z999AA10123456784",
    "NH12345678DE",
    "ABCDEFGH",
    "SIEMENS-HCFIXDRYER-0001",
    "875070392600001079",
    "$/aes-192-cbc:bd9a884281dd:2d4b766d26d2d97",
    "2026-09-27T14:47:59.859Z",
    "Schranktrocken plus",
    "wn54c2a40-1079",
    "HelloWorld",
    "LivingRoom2",
    "[not json",
  ])("leaves %s alone", (v) => {
    expect(encodedReason(v)).toBeUndefined();
  });
  it("judges the value inside the whole run", () => {
    expect(rules(input({ h: {} }, { h: "ewN7B3u2e7Y" }))).toEqual(["encoded-value h"]);
  });
});

describe("declarations", () => {
  const brand = { i: { states: { spotify: "spotify" } } };
  it("covers a finding with a reason", () => {
    const decl = { i: { "label-repeats-key": "Input names are the services' own brand names." } };
    expect(rules(input(brand, { i: "spotify" }, { declarations: decl }))).toEqual([]);
  });
  it("covers one rule only — another rule on the same datapoint still reports", () => {
    const decl = { i: { "encoded-value": "The receiver reports this token verbatim." } };
    expect(rules(input(brand, { i: "spotify" }, { declarations: decl }))).toContain("label-repeats-key i");
  });
  it("uses * for exactly one segment", () => {
    expect(patternMatches("devices.*.input", "devices.a.input")).toBe(true);
    expect(patternMatches("devices.*.input", "devices.a.b.input")).toBe(false);
  });
  it("reports a pattern that matches nothing", () => {
    const decl = { gone: { "label-repeats-key": "Input names are the services' own brand names." } };
    expect(rules(input(brand, { i: "spotify" }, { declarations: decl }))).toContain("declaration gone");
  });
  it("reports a declaration for a rule the datapoint does not break", () => {
    const decl = { i: { "encoded-value": "The receiver reports this token verbatim." } };
    const f = judgeValues(input({ i: { states: { spotify: "Spotify" } } }, { i: "spotify" }, { declarations: decl }));
    expect(f.findings.map((x) => x.message).join()).toContain("no datapoint here breaks it");
  });
  it("reports a shrug instead of a reason and an unknown rule", () => {
    const decl = { i: { "label-repeats-key": "brands", "nice-values": "whatever the reason may be" } };
    const msgs = judgeValues(input(brand, { i: "spotify" }, { declarations: decl })).findings.map((x) => x.message);
    expect(msgs.join()).toContain("only a shrug");
    expect(msgs.join()).toContain('unknown rule "nice-values"');
  });
  it("lets a listed label stay the same in both languages — and only that label", () => {
    const en = input({ c: { states: { cappuccino: "Cappuccino", hotwater: "Hot water" } } }, { c: "cappuccino" });
    const de = input({ c: { states: { cappuccino: "Cappuccino", hotwater: "Hot water" } } }, { c: "cappuccino" });
    const decl = { $sameInEveryLanguage: { Cappuccino: "An Italian coffee name, written the same in every language." } };
    const f = judgeValues({ ...en, objectsOtherLanguage: de.objects, declarations: decl }).findings;
    expect(f.map((x) => x.rule)).toEqual(["label-language"]);
    expect(f[0]?.message).toContain("hotwater=Hot water");
    expect(f[0]?.message).not.toContain("Cappuccino");
  });
  it("reports a listed label that no longer stays the same, and a shrug", () => {
    const en = input({ c: { states: { cappuccino: "Cappuccino" } } }, { c: "cappuccino" });
    const de = input({ c: { states: { cappuccino: "Kapuziner" } } }, { c: "cappuccino" });
    const decl = {
      $sameInEveryLanguage: { Cappuccino: "An Italian coffee name, written the same in every language.", Latte: "x" },
    };
    const msgs = judgeValues({ ...en, objectsOtherLanguage: de.objects, declarations: decl }).findings.map(
      (x) => `${x.id}: ${x.message}`,
    );
    expect(msgs.join()).toContain('$sameInEveryLanguage "Cappuccino": no label with this text stays the same');
    expect(msgs.join()).toContain('$sameInEveryLanguage "Latte": has no reason');
  });
  it("reports a malformed file", () => {
    expect(rules(input(brand, { i: "spotify" }, { declarations: ["x"] }))).toContain("declaration test/readable-values.json");
  });
});

describe("cli", () => {
  let dir: string;
  const lines: string[] = [];
  const out = (l: string): void => {
    lines.push(l);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "values-cli-"));
    lines.length = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (name: string, data: unknown): string => {
    const f = join(dir, name);
    writeFileSync(f, JSON.stringify(data));
    return f;
  };

  it("exits 1 with findings, 0 when clean", () => {
    const i = input({ d: {} }, { d: "cupboarddryplus" });
    const o = write("o.json", i.objects);
    const bad = write("s.json", i.states);
    expect(runValues(["--objects", o, "--states", bad, "--objects-other-language", o], out)).toBe(1);
    expect(lines.join("\n")).toContain("enum-without-list");
    const good = write("g.json", { [`${NS}d`]: { val: "Schranktrocken plus", ack: true } });
    expect(runValues(["--objects", o, "--states", good, "--objects-other-language", o], out)).toBe(0);
  });
  it("exits 2 without a second language unless --single-language is given", () => {
    const i = input({ d: {} }, { d: "x y" });
    const o = write("o.json", i.objects);
    const s = write("s.json", i.states);
    expect(runValues(["--objects", o, "--states", s], out)).toBe(2);
    expect(runValues(["--objects", o, "--states", s, "--single-language"], out)).toBe(0);
    expect(lines.join("\n")).toContain("not judged — label-language");
  });
  it("exits 2 on an unreadable or empty dump — never a silent pass", () => {
    const o = write("o.json", {});
    expect(runValues(["--objects", o, "--states", o, "--single-language"], out)).toBe(2);
    expect(runValues(["--objects", join(dir, "missing.json"), "--states", o, "--single-language"], out)).toBe(2);
  });
});
