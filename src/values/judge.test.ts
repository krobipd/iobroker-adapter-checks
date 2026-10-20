import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runValues } from "./cli.js";
import {
  encodedReason,
  judgeValues,
  patternMatches,
  type ValueInput,
} from "./judge.js";

const NS = "demo.0.";

function state(common: Record<string, unknown>): unknown {
  return {
    type: "state",
    common: {
      read: true,
      write: false,
      role: "text",
      type: "string",
      ...common,
    },
    native: {},
  };
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

const rules = (i: ValueInput): string[] =>
  judgeValues(i).findings.map((f) => `${f.rule} ${f.id}`);

describe("state-list", () => {
  it("accepts a value from the list", () => {
    expect(
      rules(input({ p: { states: { cotton: "Baumwolle" } } }, { p: "cotton" })),
    ).toEqual([]);
  });
  it("reports a value outside the list (homeconnect selectedProgram: wd45 with a two-program list)", () => {
    expect(
      rules(
        input(
          { p: { states: { cotton: "Baumwolle", eco4060: "Eco 40-60" } } },
          { p: "wd45" },
        ),
      ),
    ).toEqual(["state-list p"]);
  });
  it("reports an empty string that the list does not name", () => {
    expect(
      rules(input({ p: { states: { cotton: "Baumwolle" } } }, { p: "" })),
    ).toEqual(["state-list p"]);
  });
  it("leaves null alone — no value is not a wrong value", () => {
    expect(
      rules(input({ p: { states: { cotton: "Baumwolle" } } }, { p: null })),
    ).toEqual([]);
  });
  it("accepts a number inside min/max next to special values", () => {
    const common = {
      type: "number",
      role: "value",
      min: 0,
      max: 100,
      states: { 255: "Blink" },
    };
    expect(rules(input({ n: common }, { n: 42 }))).toEqual([]);
    expect(rules(input({ n: common }, { n: 255 }))).toEqual([]);
    expect(rules(input({ n: common }, { n: 300 }))).toEqual(["state-list n"]);
  });
  it("reports a number that the list does not name when there is no range", () => {
    expect(
      rules(
        input(
          {
            n: {
              type: "number",
              role: "value",
              states: { 0: "Aus", 1: "Ein" },
            },
          },
          { n: 2 },
        ),
      ),
    ).toEqual(["state-list n"]);
  });
});

describe("label-repeats-key", () => {
  it("reports a label that only repeats its value (homeconnect: auto2 = auto2)", () => {
    const f = judgeValues(
      input(
        { p: { states: { auto2: "auto2", eco50: "Eco 50 °C" } } },
        { p: "eco50" },
      ),
    ).findings;
    expect(f.map((x) => x.rule)).toEqual(["label-repeats-key"]);
    expect(f[0]?.message).toContain("auto2");
  });
  it("accepts a real label even when it only differs in case", () => {
    expect(
      rules(input({ s: { states: { off: "Off" } } }, { s: "off" })),
    ).toEqual([]);
  });
});

describe("label-language", () => {
  it("reports a translation object as a label — the admin cannot render it", () => {
    expect(
      rules(input({ m: { states: { a: { en: "A", de: "A" } } } }, { m: "a" })),
    ).toEqual(["label-language m"]);
  });
  it("reports labels that stay the same in the second language (homeconnect: Running)", () => {
    const en = input(
      { o: { states: { run: "Running", ready: "Ready" } } },
      { o: "run" },
    );
    const de = input(
      { o: { states: { run: "Running", ready: "Bereit" } } },
      { o: "run" },
    );
    const f = judgeValues({ ...en, objectsOtherLanguage: de.objects }).findings;
    expect(f.map((x) => `${x.rule} ${x.id}`)).toEqual(["label-language o"]);
    expect(f[0]?.message).toContain("run=Running");
    expect(f[0]?.message).not.toContain("Bereit");
  });
  it("accepts labels without letters (numbers, units) in both languages", () => {
    const i = input(
      { t: { states: { gc40: "40 °C", e: "1.5 kWh", p: "20 %" } } },
      { t: "gc40" },
    );
    expect(rules({ ...i, objectsOtherLanguage: i.objects })).toEqual([]);
  });
  it("still reports rpm — German writes U/min", () => {
    const i = input(
      { t: { states: { rpm1400: "1400 rpm" } } },
      { t: "rpm1400" },
    );
    expect(rules({ ...i, objectsOtherLanguage: i.objects })).toEqual([
      "label-language t",
    ]);
  });
  it("says it did not judge the rule without a second language", () => {
    const i = input({ o: { states: { run: "Running" } } }, { o: "run" });
    const r = judgeValues(i);
    expect(r.findings).toEqual([]);
    expect(r.notJudged.join()).toContain("label-language");
  });
});

describe("same-name", () => {
  const dev = { type: "device", common: { name: "Oven" } };
  const st = (name: unknown): Record<string, unknown> => ({
    type: "state",
    common: {
      name,
      type: "boolean",
      role: "indicator",
      read: true,
      write: false,
    },
  });
  const run = (
    objects: Record<string, unknown>,
    other?: Record<string, unknown>,
  ): ReturnType<typeof judgeValues>["findings"] =>
    judgeValues({
      objects,
      states: {},
      objectsOtherLanguage: other,
    }).findings.filter((f) => f.rule === "same-name");

  it("reports two datapoints of one device with one name, per language and across channels", () => {
    const found = run({
      "demo.0.oven": dev,
      "demo.0.oven.setting.powerState": st({
        en: "Power state",
        de: "Betriebszustand",
      }),
      "demo.0.oven.status.operationState": st({
        en: "Operation state",
        de: "Betriebszustand",
      }),
      "demo.0.oven.segments.0.brightness": st("Brightness"),
      "demo.0.oven.segments.1.brightness": st("brightness "),
    });
    expect(found.map((f) => f.id).sort()).toEqual([
      "oven.segments.0.brightness",
      "oven.segments.1.brightness",
      "oven.setting.powerState",
      "oven.status.operationState",
    ]);
    expect(
      found.find((f) => f.id === "oven.setting.powerState")?.message,
    ).toContain("in de —");
  });

  it("passes distinct names, falls back to English, ignores states outside a device, judges the second run", () => {
    expect(
      run({
        "demo.0.oven": dev,
        "demo.0.oven.a": st({ en: "Power", de: "Boost" }),
        "demo.0.oven.b": st({ en: "Boost" }),
        "demo.0.loose1": st("Same"),
        "demo.0.loose2": st("Same"),
      }).map((f) => f.id),
    ).toEqual(["oven.a", "oven.b"]);
    expect(
      run(
        {
          "demo.0.oven": dev,
          "demo.0.oven.a": st("A"),
          "demo.0.oven.b": st("B"),
        },
        {
          "demo.0.oven": dev,
          "demo.0.oven.a": st("Tuer"),
          "demo.0.oven.b": st("Tuer"),
        },
      ),
    ).toHaveLength(2);
  });
});

describe("id-language", () => {
  it("accepts two runs that created the same ids", () => {
    const i = input({ a: {}, b: {} }, {});
    expect(rules({ ...i, objectsOtherLanguage: i.objects })).toEqual([]);
  });
  it("reports an id that only one language run created, on its side", () => {
    const en = input({ a: {}, "info.status": {} }, {});
    const de = input({ a: {}, "info.zustand": {} }, {});
    const f = judgeValues({ ...en, objectsOtherLanguage: de.objects }).findings;
    expect(f.map((x) => `${x.rule} ${x.id}`)).toEqual([
      "id-language info.status",
      "id-language info.zustand",
    ]);
    expect(f[0]?.message).toContain("first system language");
    expect(f[1]?.message).toContain("second system language");
  });
  it("counts channels and devices too, not only states", () => {
    const en = input({ a: {} }, {});
    const de = input({ a: {} }, {});
    en.objects[`${NS}kitchen`] = {
      type: "channel",
      common: { name: "Kitchen" },
    };
    de.objects[`${NS}kueche`] = { type: "channel", common: { name: "Küche" } };
    expect(rules({ ...en, objectsOtherLanguage: de.objects })).toEqual([
      "id-language kitchen",
      "id-language kueche",
    ]);
  });
});

describe("enum-without-list", () => {
  it("reports an identifier value without a list (homeconnect dryingTarget)", () => {
    expect(rules(input({ d: {} }, { d: "cupboarddryplus" }))).toEqual([
      "enum-without-list d",
    ]);
  });
  it("leaves free text, names and writable states alone", () => {
    expect(
      rules(
        input(
          { a: {}, b: {}, c: { write: true } },
          { a: "Unknown", b: "Mein Gerät", c: "fluffing" },
        ),
      ),
    ).toEqual([]);
  });
  it("leaves numbers and booleans alone", () => {
    expect(
      rules(
        input(
          { a: { type: "number" }, b: { type: "boolean" } },
          { a: 3, b: true },
        ),
      ),
    ).toEqual([]);
  });
});

describe("encoded-value", () => {
  it.each([
    ["ewN7B3u2e7Y", "history uid"],
    ["AL0A-QAMAAw", "effective time"],
    ["D3sHAF0AXwANqOA", "program details"],
    ["AEQAGABFAAA", "all upper case, but NUL bytes inside"],
    ["e3t7A3u5e84", "a history uid with few control bytes"],
  ])("reports homeconnect's base64 value %s (%s)", (v) => {
    expect(encodedReason(v)).toContain("base64");
  });
  it("reports raw JSON, also an empty list (homeconnect errorCodesList)", () => {
    expect(
      encodedReason('{"counter":359,"sequence":[{"program":31670}]}'),
    ).toContain("JSON");
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
    "Cortex-A72",
    "/dev/ttyS0",
    "nvme0n1",
    "[not json",
  ])("leaves %s alone", (v) => {
    expect(encodedReason(v)).toBeUndefined();
  });
  it("judges the value inside the whole run", () => {
    expect(rules(input({ h: {} }, { h: "ewN7B3u2e7Y" }))).toEqual([
      "encoded-value h",
    ]);
  });
});

describe("onoff-as-text", () => {
  it("reports a text state whose list is exactly one on/off pair (nut2 outlet status)", () => {
    expect(
      rules(input({ s: { states: { on: "On", off: "Off" } } }, { s: "on" })),
    ).toEqual(["onoff-as-text s"]);
  });
  it("reads the pair without case and knows the other pairs", () => {
    expect(
      rules(
        input(
          {
            a: { states: { TRUE: "Yes", FALSE: "No" } },
            b: { states: { enabled: "Enabled", disabled: "Disabled" } },
            c: { states: { open: "Open", closed: "Closed" } },
          },
          {},
        ),
      ),
    ).toEqual(["onoff-as-text a", "onoff-as-text b", "onoff-as-text c"]);
  });
  it("leaves a list with a third value, a number list and a boolean alone", () => {
    expect(
      rules(
        input(
          {
            a: { states: { on: "On", off: "Off", auto: "Auto" } },
            b: { type: "number", states: { 0: "Off", 1: "On" } },
            c: { type: "boolean", role: "switch" },
            d: { states: { on: "On", standby: "Standby" } },
          },
          {},
        ),
      ),
    ).toEqual([]);
  });
});

describe("info-role", () => {
  it("reports a firmware, model or serial leaf without its info role (homewizard, nut2, yamaha)", () => {
    expect(
      rules(
        input(
          {
            "dev.info.firmware": {},
            "dev.ups.model": {},
            "dev.ups.serial": {},
            "dev.mac": {},
            "dev.ip_address": {},
            "dev.port": { type: "number", role: "value" },
            "dev.hardware": {},
          },
          {},
        ),
      ),
    ).toEqual([
      "info-role dev.hardware",
      "info-role dev.info.firmware",
      "info-role dev.ip_address",
      "info-role dev.mac",
      "info-role dev.port",
      "info-role dev.ups.model",
      "info-role dev.ups.serial",
    ]);
  });
  it("accepts the info role and a more detailed role below it", () => {
    expect(
      rules(
        input(
          {
            "a.firmware": { role: "info.firmware" },
            "a.serialNumber": { role: "info.serial" },
            "a.model": { role: "info.model.detail" },
            "a.firmwareUpdate": { type: "boolean", role: "indicator" },
          },
          {},
        ),
      ),
    ).toEqual([]);
  });
  it("names the role the catalog gives", () => {
    const f = judgeValues(input({ "d.firmware": {} }, {})).findings;
    expect(f[0]?.message).toContain("info.firmware");
  });
});

describe("unit-on-non-number", () => {
  it("reports a unit on text and on a boolean", () => {
    expect(
      rules(
        input(
          {
            a: { unit: "°C" },
            b: { type: "boolean", role: "indicator", unit: "%" },
          },
          {},
        ),
      ),
    ).toEqual(["unit-on-non-number a", "unit-on-non-number b"]);
  });
  it("accepts a unit on a number and an empty unit anywhere", () => {
    expect(
      rules(
        input(
          { a: { type: "number", role: "value", unit: "W" }, b: { unit: "" } },
          {},
        ),
      ),
    ).toEqual([]);
  });
});

describe("min-above-max and step-not-positive", () => {
  it("reports min above max and a step of zero or below", () => {
    expect(
      rules(
        input(
          {
            a: { type: "number", role: "level", write: true, min: 10, max: 5 },
            b: { type: "number", role: "level", write: true, step: 0 },
            c: { type: "number", role: "level", write: true, step: -1 },
          },
          {},
        ),
      ),
    ).toEqual([
      "min-above-max a",
      "step-not-positive b",
      "step-not-positive c",
    ]);
  });
  it("accepts min equal to max and a fractional step", () => {
    expect(
      rules(
        input(
          {
            a: {
              type: "number",
              role: "level",
              write: true,
              min: 5,
              max: 5,
              step: 0.5,
            },
          },
          {},
        ),
      ),
    ).toEqual([]);
  });
});

describe("default-not-allowed", () => {
  it("reports a default outside min/max and one the list does not name", () => {
    expect(
      rules(
        input(
          {
            a: {
              type: "number",
              role: "level",
              write: true,
              min: 0,
              max: 100,
              def: 150,
            },
            b: { states: { eco: "Eco", fast: "Fast" }, def: "turbo" },
          },
          {},
        ),
      ),
    ).toEqual(["default-not-allowed a", "default-not-allowed b"]);
  });
  it("accepts a default inside the range next to special values, and a listed one", () => {
    expect(
      rules(
        input(
          {
            a: {
              type: "number",
              role: "level",
              write: true,
              min: 0,
              max: 100,
              def: 40,
              states: { "-1": "Off" },
            },
            b: { states: { eco: "Eco", fast: "Fast" }, def: "eco" },
            c: { type: "number", role: "value", def: 0 },
          },
          {},
        ),
      ),
    ).toEqual([]);
  });
});

describe("list-keys-type", () => {
  it("reports a number state whose list keys are words", () => {
    expect(
      rules(
        input(
          {
            a: {
              type: "number",
              role: "value",
              states: { low: "Low", high: "High" },
            },
          },
          {},
        ),
      ),
    ).toEqual(["list-keys-type a"]);
  });
  it("accepts numeric keys, negatives and decimals", () => {
    expect(
      rules(
        input(
          {
            a: {
              type: "number",
              role: "value",
              states: { "-1": "Off", 0: "Low", 2.5: "Mid" },
            },
          },
          {},
        ),
      ),
    ).toEqual([]);
  });
});

describe("declarations", () => {
  const brand = { i: { states: { spotify: "spotify" } } };
  it("covers a finding with a reason", () => {
    const decl = {
      i: {
        "label-repeats-key": "Input names are the services' own brand names.",
      },
    };
    expect(
      rules(input(brand, { i: "spotify" }, { declarations: decl })),
    ).toEqual([]);
  });
  it("covers one rule only — another rule on the same datapoint still reports", () => {
    const decl = {
      i: { "encoded-value": "The receiver reports this token verbatim." },
    };
    expect(
      rules(input(brand, { i: "spotify" }, { declarations: decl })),
    ).toContain("label-repeats-key i");
  });
  it("uses * for exactly one segment", () => {
    expect(patternMatches("devices.*.input", "devices.a.input")).toBe(true);
    expect(patternMatches("devices.*.input", "devices.a.b.input")).toBe(false);
  });
  it("reports a pattern that matches nothing", () => {
    const decl = {
      gone: {
        "label-repeats-key": "Input names are the services' own brand names.",
      },
    };
    expect(
      rules(input(brand, { i: "spotify" }, { declarations: decl })),
    ).toContain("declaration gone");
  });
  it("reports a declaration for a rule the datapoint does not break", () => {
    const decl = {
      i: { "encoded-value": "The receiver reports this token verbatim." },
    };
    const f = judgeValues(
      input(
        { i: { states: { spotify: "Spotify" } } },
        { i: "spotify" },
        { declarations: decl },
      ),
    );
    expect(f.findings.map((x) => x.message).join()).toContain(
      "no datapoint here breaks it",
    );
  });
  it("reports a shrug instead of a reason and an unknown rule", () => {
    const decl = {
      i: {
        "label-repeats-key": "brands",
        "nice-values": "whatever the reason may be",
      },
    };
    const msgs = judgeValues(
      input(brand, { i: "spotify" }, { declarations: decl }),
    ).findings.map((x) => x.message);
    expect(msgs.join()).toContain("only a shrug");
    expect(msgs.join()).toContain('unknown rule "nice-values"');
  });
  describe("on one installation's tree (partialTree)", () => {
    const decl = {
      gone: {
        "label-repeats-key": "Input names are the services' own brand names.",
      },
      i: { "encoded-value": "The receiver reports this token verbatim." },
    };
    it("leaves coverage unjudged and says so", () => {
      const r = judgeValues(
        input(
          { i: { states: { spotify: "Spotify" } } },
          { i: "spotify" },
          { declarations: decl, partialTree: true },
        ),
      );
      expect(r.findings).toEqual([]);
      expect(r.notJudged.join()).toContain("declaration coverage");
    });
    it("judges coverage without it — the same input has two findings", () => {
      const r = judgeValues(
        input(
          { i: { states: { spotify: "Spotify" } } },
          { i: "spotify" },
          { declarations: decl },
        ),
      );
      expect(r.findings.map((x) => `${x.rule} ${x.id}`).sort()).toEqual([
        "declaration gone",
        "declaration i",
      ]);
      expect(r.notJudged.join()).not.toContain("declaration coverage");
    });
    it("still reports an undeclared finding and a shrug", () => {
      const r = judgeValues(
        input(
          brand,
          { i: "spotify" },
          {
            declarations: { x: { "label-repeats-key": "brands" } },
            partialTree: true,
          },
        ),
      );
      const all = r.findings.map((x) => `${x.rule} ${x.id} ${x.message}`);
      expect(all.join()).toContain("label-repeats-key i");
      expect(all.join()).toContain("only a shrug");
    });
    it("still covers a declared finding", () => {
      expect(
        rules(
          input(
            brand,
            { i: "spotify" },
            {
              declarations: {
                i: {
                  "label-repeats-key":
                    "Input names are the services' own brand names.",
                },
              },
              partialTree: true,
            },
          ),
        ),
      ).toEqual([]);
    });
  });
  it("lets a listed label stay the same in both languages — and only that label", () => {
    const en = input(
      { c: { states: { cappuccino: "Cappuccino", hotwater: "Hot water" } } },
      { c: "cappuccino" },
    );
    const de = input(
      { c: { states: { cappuccino: "Cappuccino", hotwater: "Hot water" } } },
      { c: "cappuccino" },
    );
    const decl = {
      $sameInEveryLanguage: {
        Cappuccino:
          "An Italian coffee name, written the same in every language.",
      },
    };
    const f = judgeValues({
      ...en,
      objectsOtherLanguage: de.objects,
      declarations: decl,
    }).findings;
    expect(f.map((x) => x.rule)).toEqual(["label-language"]);
    expect(f[0]?.message).toContain("hotwater=Hot water");
    expect(f[0]?.message).not.toContain("Cappuccino");
  });
  it("reports a listed label that no longer stays the same, and a shrug", () => {
    const en = input(
      { c: { states: { cappuccino: "Cappuccino" } } },
      { c: "cappuccino" },
    );
    const de = input(
      { c: { states: { cappuccino: "Kapuziner" } } },
      { c: "cappuccino" },
    );
    const decl = {
      $sameInEveryLanguage: {
        Cappuccino:
          "An Italian coffee name, written the same in every language.",
        Latte: "x",
      },
    };
    const msgs = judgeValues({
      ...en,
      objectsOtherLanguage: de.objects,
      declarations: decl,
    }).findings.map((x) => `${x.id}: ${x.message}`);
    expect(msgs.join()).toContain(
      '$sameInEveryLanguage "Cappuccino": no label with this text stays the same',
    );
    expect(msgs.join()).toContain(
      '$sameInEveryLanguage "Latte": has no reason',
    );
  });
  it("leaves an unused same-label declaration unjudged on one installation's tree", () => {
    const en = input(
      { c: { states: { cappuccino: "Cappuccino" } } },
      { c: "cappuccino" },
    );
    const de = input(
      { c: { states: { cappuccino: "Kapuziner" } } },
      { c: "cappuccino" },
    );
    const decl = {
      $sameInEveryLanguage: {
        Cappuccino:
          "An Italian coffee name, written the same in every language.",
      },
    };
    const msgs = judgeValues({
      ...en,
      objectsOtherLanguage: de.objects,
      declarations: decl,
      partialTree: true,
    }).findings.map((x) => `${x.id}: ${x.message}`);
    expect(msgs.join()).not.toContain("no label with this text");
  });
  it("reports a malformed file", () => {
    expect(
      rules(input(brand, { i: "spotify" }, { declarations: ["x"] })),
    ).toContain("declaration test/readable-values.json");
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
    expect(
      runValues(
        ["--objects", o, "--states", bad, "--objects-other-language", o],
        out,
      ),
    ).toBe(1);
    expect(lines.join("\n")).toContain("enum-without-list");
    const good = write("g.json", {
      [`${NS}d`]: { val: "Schranktrocken plus", ack: true },
    });
    expect(
      runValues(
        ["--objects", o, "--states", good, "--objects-other-language", o],
        out,
      ),
    ).toBe(0);
  });
  it("exits 2 without a second language unless --single-language is given", () => {
    const i = input({ d: {} }, { d: "x y" });
    const o = write("o.json", i.objects);
    const s = write("s.json", i.states);
    expect(runValues(["--objects", o, "--states", s], out)).toBe(2);
    expect(
      runValues(["--objects", o, "--states", s, "--single-language"], out),
    ).toBe(0);
    expect(lines.join("\n")).toContain("not judged — label-language");
  });
  it("--partial-tree leaves declaration coverage unjudged", () => {
    const i = input({ d: {} }, { d: "x y" });
    const o = write("o.json", i.objects);
    const s = write("s.json", i.states);
    const d = write("d.json", {
      gone: { "encoded-value": "The receiver reports this token verbatim." },
    });
    const base = ["--objects", o, "--states", s, "--single-language"];
    expect(runValues([...base, "--declarations", d], out)).toBe(1);
    expect(
      runValues([...base, "--declarations", d, "--partial-tree"], out),
    ).toBe(0);
    expect(lines.join("\n")).toContain("not judged — declaration coverage");
  });
  it("exits 2 on an unreadable or empty dump — never a silent pass", () => {
    const o = write("o.json", {});
    expect(
      runValues(["--objects", o, "--states", o, "--single-language"], out),
    ).toBe(2);
    expect(
      runValues(
        [
          "--objects",
          join(dir, "missing.json"),
          "--states",
          o,
          "--single-language",
        ],
        out,
      ),
    ).toBe(2);
  });
});
