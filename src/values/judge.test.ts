import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runValues, USAGE } from "./cli.js";
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

  it("reports a group that both language runs find once", () => {
    const objects = {
      "demo.0.oven": dev,
      "demo.0.oven.a": st({ en: "Door", de: "Tuer" }),
      "demo.0.oven.b": st({ en: "Door", de: "Tuer" }),
    };
    expect(run(objects, objects).map((f) => f.id)).toEqual([
      "oven.a",
      "oven.b",
    ]);
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
  it("knows every rule the judge reports as a declarable rule", () => {
    for (const rule of [
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
    ]) {
      const msgs = judgeValues(
        input(
          brand,
          { i: "spotify" },
          {
            declarations: { i: { [rule]: "a reason long enough to count" } },
          },
        ),
      ).findings.map((x) => x.message);
      expect(msgs.join(), rule).not.toContain("unknown rule");
    }
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

describe("unit-value", () => {
  // dl-manager before 174c9fa: behind Deluge, Flood passes Deluge's limit on unchanged in KiB/s, and the driver read it
  // as bytes per second — 1/1024 of the real limit, with type and range right
  // (test/fixtures/flood/4.16.4-deluge/limited/settings.json).
  const RECORDING = "test/fixtures/flood/4.16.4-deluge/limited/settings.json";
  const files: Record<string, string> = {
    [RECORDING]:
      '{"throttleGlobalDownSpeed": 102400, "throttleGlobalUpSpeed": 51200}',
    // files that carry the number but are no recording under test/
    "src/lib/flood.ts": "const LIMIT = 102400;",
    "test/../src/lib/flood.ts": "const LIMIT = 102400;",
  };
  const readFile = (path: string): string | undefined => files[path];
  const num = (unit: string, role = "value"): Record<string, unknown> => ({
    type: "number",
    role,
    unit,
  });
  function unitInput(
    objs: Record<string, Record<string, unknown>>,
    vals: Record<string, unknown>,
    unitValues: unknown,
    extra: Partial<ValueInput> = {},
  ): ValueInput {
    const base = input(objs, vals);
    for (const device of ["flood-flood", "deluge-deluge"]) {
      base.objects[`${NS}${device}`] = {
        type: "device",
        common: { name: device },
        native: {},
      };
    }
    return { ...base, unitValues, readFile, ...extra };
  }
  const limit = {
    "flood-flood.speedLimit": {
      id: "flood-flood.speedLimit",
      recorded: 102400,
      unit: "KiB/s",
      file: RECORDING,
    },
  };
  const unitRules = (i: ValueInput): string[] =>
    judgeValues(i)
      .findings.filter((f) => f.rule === "unit-value")
      .map((f) => `${f.id}: ${f.message}`);

  it("reports the limit 1/1024 of the recorded one, accepts it in the datapoint's unit (dl-manager before 174c9fa)", () => {
    const objs = { "flood-flood.speedLimit": num("MB/s", "level") };
    expect(
      unitRules(
        unitInput(objs, { "flood-flood.speedLimit": 0.09765625 }, limit),
      ),
    ).toEqual([
      "flood-flood.speedLimit: value 0.09765625 MB/s, but the recorded 102400 KiB/s is 104.9 or 100 MB/s",
    ]);
    expect(
      unitRules(unitInput(objs, { "flood-flood.speedLimit": 100 }, limit)),
    ).toEqual([]);
  });
  it("accepts a value rounded for display within the tolerance, never one further off", () => {
    const objs = { "flood-flood.downloadSpeed": num("MB/s") };
    const sample = {
      "flood-flood.downloadSpeed": {
        id: "flood-flood.downloadSpeed",
        recorded: 102400,
        unit: "B/s",
        file: RECORDING,
      },
    };
    expect(
      unitRules(unitInput(objs, { "flood-flood.downloadSpeed": 0.1 }, sample)),
    ).toEqual([]);
    expect(
      unitRules(unitInput(objs, { "flood-flood.downloadSpeed": 0.11 }, sample)),
    ).toHaveLength(1);
  });
  it("never accepts a recorded number the adapter rounds to 0 in its unit, accepts the same number kept", () => {
    // 512 B/s is 0.000512 MB/s — rounded to two decimals the datapoint shows 0, which is no reading of the recording
    const objs = { "flood-flood.uploadLimit": num("MB/s", "level") };
    const files512: Record<string, string> = {
      [RECORDING]: '{"throttleGlobalUpSpeed": 512}',
    };
    const entry = {
      "flood-flood.uploadLimit": {
        id: "flood-flood.uploadLimit",
        recorded: 512,
        unit: "B/s",
        file: RECORDING,
      },
    };
    const judged = (value: number): string[] =>
      unitRules({
        ...unitInput(objs, { "flood-flood.uploadLimit": value }, entry),
        readFile: (p) => files512[p],
      });
    expect(judged(0)).toEqual([
      "flood-flood.uploadLimit: value 0 MB/s, but the recorded 512 B/s is 0.000512 or 0.0004883 MB/s",
    ]);
    expect(judged(0.000512)).toEqual([]);
  });
  it("proves a value the adapter computes from recorded numbers by the operation over them", () => {
    const objs = {
      "flood-flood.downloadSpeed": num("MB/s"),
      "flood-flood.progress": num("%"),
    };
    const leaf = (recorded: number): Record<string, unknown> => ({
      recorded,
      unit: "B/s",
      file: RECORDING,
    });
    const computed = {
      "flood-flood.downloadSpeed": {
        id: "flood-flood.downloadSpeed",
        computed: { sum: [leaf(102400), leaf(51200)] },
      },
      "flood-flood.progress": {
        id: "flood-flood.progress",
        computed: { quotient: [leaf(51200), leaf(102400)] },
      },
    };
    expect(
      unitRules(
        unitInput(
          objs,
          { "flood-flood.downloadSpeed": 0.1536, "flood-flood.progress": 50 },
          computed,
        ),
      ),
    ).toEqual([]);
    expect(
      unitRules(
        unitInput(
          objs,
          { "flood-flood.downloadSpeed": 150, "flood-flood.progress": 0.5 },
          computed,
        ),
      ),
    ).toEqual([
      "flood-flood.downloadSpeed: value 150 MB/s, but the value computed from 2 recorded numbers is 0.1536 or 0.1465 MB/s",
      "flood-flood.progress: value 0.5 %, but the value computed from 2 recorded numbers is 50 %",
    ]);
  });
  it("reports a computed value whose form, recordings or units cannot prove anything", () => {
    const objs = { "flood-flood.downloadSpeed": num("MB/s") };
    const leaf = (fields: Record<string, unknown> = {}): unknown => ({
      recorded: 102400,
      unit: "B/s",
      file: RECORDING,
      ...fields,
    });
    const one = (entry: Record<string, unknown>): string[] =>
      unitRules(
        unitInput(
          objs,
          { "flood-flood.downloadSpeed": 0.1536 },
          {
            "flood-flood.downloadSpeed": {
              id: "flood-flood.downloadSpeed",
              ...entry,
            },
          },
        ),
      );
    const terms = `{ "recorded": <number>, "unit": "<its unit>", "file": "test/<recording>" } or { "<sum|mean|difference|quotient>": [<terms>] }`;
    expect(one({ computed: leaf() })).toEqual([
      'flood-flood.downloadSpeed: "computed" holds one recorded number — give it as "recorded", "unit" and "file"',
    ]);
    for (const computed of [
      { product: [leaf(), leaf()] },
      { sum: [leaf(), leaf()], mean: [leaf(), leaf()] },
      { sum: [leaf(), "x"] },
      { sum: [leaf(), null] },
      { sum: [leaf(), leaf({ unit: "" })] },
      "x",
    ]) {
      expect(one({ computed })).toEqual([
        `flood-flood.downloadSpeed: "computed" expects ${terms}`,
      ]);
    }
    expect(one({ computed: { difference: [leaf(), leaf(), leaf()] } })).toEqual(
      ['flood-flood.downloadSpeed: "difference" takes two terms'],
    );
    expect(one({ computed: { quotient: [leaf()] } })).toEqual([
      'flood-flood.downloadSpeed: "quotient" takes two terms',
    ]);
    expect(one({ computed: { sum: [leaf()] } })).toEqual([
      'flood-flood.downloadSpeed: "sum" takes a list of two or more terms',
    ]);
    expect(one({ computed: { mean: leaf() } })).toEqual([
      'flood-flood.downloadSpeed: "mean" takes a list of two or more terms',
    ]);
    expect(
      one({ computed: { sum: [leaf(), leaf({ file: "src/lib/flood.ts" })] } }),
    ).toEqual([
      'flood-flood.downloadSpeed: "src/lib/flood.ts" is no recorded file under test/',
    ]);
    expect(one({ computed: { sum: [leaf(), leaf({ recorded: 7 })] } })).toEqual(
      [
        `flood-flood.downloadSpeed: 7 does not stand in ${RECORDING} — the value comes from the recording, never from the adapter's run`,
      ],
    );
    expect(
      one({
        computed: { difference: [leaf(), leaf()] },
      }),
    ).toEqual([
      "flood-flood.downloadSpeed: a computed 0 tells no unit apart — name a datapoint whose recordings give another number",
    ]);
    expect(
      one({ computed: { quotient: [leaf({ unit: "B" }), leaf()] } }),
    ).toEqual([
      'flood-flood.downloadSpeed: the computed value does not convert to "MB/s"',
    ]);
    const entry = `{ "id": "<datapoint>", "recorded": <number>, "unit": "<its unit>", "file": "test/<recording>" } or { "id": "<datapoint>", "computed": { "<sum|mean|difference|quotient>": [<terms>] } }`;
    for (const extra of [
      { recorded: 102400 },
      { unit: "B/s" },
      { file: RECORDING },
      { recorded: 102400, unit: "B/s", file: RECORDING },
    ]) {
      expect(one({ computed: { sum: [leaf(), leaf()] }, ...extra })).toEqual([
        `flood-flood.downloadSpeed: expected ${entry}`,
      ]);
    }
    expect(one({})).toEqual([`flood-flood.downloadSpeed: expected ${entry}`]);
  });
  it("reports every number with a unit that no entry covers, never a number without one or a text", () => {
    const objs = {
      "flood-flood.speedLimit": num("MB/s", "level"),
      "flood-flood.uploadLimit": num("MB/s", "level"),
      "flood-flood.torrents": { type: "number", role: "value" },
      "flood-flood.ratio": num(""),
      "flood-flood.state": { type: "string", role: "text", unit: "MB/s" },
    };
    const vals = {
      "flood-flood.speedLimit": 100,
      "flood-flood.uploadLimit": 50,
      "flood-flood.torrents": 7,
      "flood-flood.ratio": 1.5,
      "flood-flood.state": "seeding",
    };
    expect(unitRules(unitInput(objs, vals, limit))).toEqual([
      'flood-flood.uploadLimit: no entry in test/unit-values.json covers this number in "MB/s" — name one datapoint of its kind with the value its recording carries',
    ]);
    expect(unitRules(unitInput(objs, vals, {}))).toHaveLength(2);
  });
  it("lets one entry speak for the entries of a list, never for two names, roles, units or devices", () => {
    const objs = {
      "flood-flood.items.a.downloadSpeed": num("MB/s"),
      "flood-flood.items.b.downloadSpeed": num("MB/s"),
      "flood-flood.items.a.uploadSpeed": num("MB/s"),
      "flood-flood.items.c.downloadSpeed": num("MB/s", "level"),
      "flood-flood.items.d.downloadSpeed": num("kB/s"),
      "deluge-deluge.items.a.downloadSpeed": num("MB/s"),
    };
    const vals = Object.fromEntries(Object.keys(objs).map((k) => [k, 0.1]));
    const entry = (pattern: string): unknown => ({
      [pattern]: {
        id: "flood-flood.items.a.downloadSpeed",
        recorded: 102400,
        unit: "B/s",
        file: RECORDING,
      },
    });
    const list = { ...objs };
    delete (list as Record<string, unknown>)["flood-flood.items.a.uploadSpeed"];
    delete (list as Record<string, unknown>)[
      "flood-flood.items.c.downloadSpeed"
    ];
    delete (list as Record<string, unknown>)[
      "flood-flood.items.d.downloadSpeed"
    ];
    delete (list as Record<string, unknown>)[
      "deluge-deluge.items.a.downloadSpeed"
    ];
    expect(
      unitRules(
        unitInput(list, vals, entry("flood-flood.items.*.downloadSpeed")),
      ),
    ).toEqual([]);
    for (const [pattern, other] of [
      ["flood-flood.items.a.*", "flood-flood.items.a.uploadSpeed"],
      [
        "flood-flood.items.*.downloadSpeed",
        "flood-flood.items.c.downloadSpeed",
      ],
      ["*.items.a.downloadSpeed", "deluge-deluge.items.a.downloadSpeed"],
    ] as const) {
      const only = Object.fromEntries(
        Object.entries(objs).filter(
          ([k]) =>
            k === "flood-flood.items.a.downloadSpeed" ||
            k === other ||
            k === "flood-flood.items.b.downloadSpeed",
        ),
      );
      expect(unitRules(unitInput(only, vals, entry(pattern))).join()).toContain(
        `${pattern}: covers more than one kind`,
      );
    }
    const units = {
      "flood-flood.items.a.downloadSpeed": num("MB/s"),
      "flood-flood.items.d.downloadSpeed": num("kB/s"),
    };
    expect(
      unitRules(
        unitInput(units, vals, entry("flood-flood.items.*.downloadSpeed")),
      ).join(),
    ).toContain("covers more than one kind");
  });
  it("takes the nearest device object as the device, also below a folder", () => {
    const objs = { "devices.a.power": num("W"), "devices.b.power": num("W") };
    const vals = { "devices.a.power": 12, "devices.b.power": 12 };
    const decl = {
      "devices.*.power": {
        id: "devices.a.power",
        recorded: 102400,
        unit: "W",
        file: RECORDING,
      },
    };
    const base = input(objs, vals);
    for (const device of ["devices.a", "devices.b"]) {
      base.objects[`${NS}${device}`] = {
        type: "device",
        common: { name: device },
        native: {},
      };
    }
    expect(unitRules({ ...base, unitValues: decl, readFile }).join()).toContain(
      "devices.*.power: covers more than one kind",
    );
  });
  it("takes the first segment as the device where no device object stands above", () => {
    const objs = { "bridge.a.power": num("W"), "hub.a.power": num("W") };
    const vals = { "bridge.a.power": 12, "hub.a.power": 12 };
    const files2 = { "test/r.json": '{"p": 12}' };
    const decl = {
      "*.a.power": {
        id: "bridge.a.power",
        recorded: 12,
        unit: "W",
        file: "test/r.json",
      },
    };
    expect(
      judgeValues({
        ...input(objs, vals),
        unitValues: decl,
        readFile: (p) => files2[p as keyof typeof files2],
      })
        .findings.map((f) => f.message)
        .join(),
    ).toContain("covers more than one kind");
  });
  it("reports an entry whose sample, value, recording or units cannot prove anything", () => {
    const objs = {
      "flood-flood.speedLimit": num("MB/s", "level"),
      "flood-flood.uploadLimit": num("MB/s", "level"),
    };
    const vals = {
      "flood-flood.speedLimit": 100,
      "flood-flood.uploadLimit": null,
    };
    const one = (
      fields: Record<string, unknown>,
      pattern = "flood-flood.speedLimit",
    ): string[] =>
      unitRules(
        unitInput(objs, vals, {
          [pattern]: { ...limit["flood-flood.speedLimit"], ...fields },
          ...(pattern === "flood-flood.speedLimit"
            ? {
                "flood-flood.uploadLimit": {
                  ...limit["flood-flood.speedLimit"],
                  id: "flood-flood.uploadLimit",
                },
              }
            : {}),
        }),
      ).filter((m) => !m.startsWith("flood-flood.uploadLimit"));
    expect(one({ id: "flood-flood.uploadLimit" })).toEqual([
      'flood-flood.speedLimit: sample "flood-flood.uploadLimit" is not a number with a unit this pattern covers',
    ]);
    expect(one({ recorded: 0 })).toEqual([
      "flood-flood.speedLimit: a recorded 0 tells no unit apart — name a datapoint whose recording carries another number",
    ]);
    expect(one({ file: "src/lib/flood.ts" })).toEqual([
      'flood-flood.speedLimit: "src/lib/flood.ts" is no recorded file under test/',
    ]);
    expect(one({ file: "test/../src/lib/flood.ts" })).toEqual([
      'flood-flood.speedLimit: "test/../src/lib/flood.ts" is no recorded file under test/',
    ]);
    expect(one({ file: "test/fixtures/missing.json" })).toEqual([
      'flood-flood.speedLimit: "test/fixtures/missing.json" is no recorded file under test/',
    ]);
    expect(one({ recorded: 104857.6 })).toEqual([
      `flood-flood.speedLimit: 104857.6 does not stand in ${RECORDING} — the value comes from the recording, never from the adapter's run`,
    ]);
    expect(one({ unit: "s" })).toEqual([
      'flood-flood.speedLimit: cannot convert "s" to "MB/s" — give the unit the recording carries',
    ]);
    expect(one({ unit: "" })[0]).toContain("expected {");
    expect(one({ unit: 7 })[0]).toContain("expected {");
    expect(one({ recorded: "102400" })[0]).toContain("expected {");
    expect(one({ recorded: Number.NaN })[0]).toContain("NaN does not stand in");
    expect(one({ id: 7 })[0]).toContain("expected {");
    expect(one({ file: 7 })[0]).toContain("expected {");
    expect(
      unitRules(
        unitInput(objs, vals, {
          "flood-flood.speedLimit": null,
          "flood-flood.uploadLimit": null,
        }),
      )[0],
    ).toContain("expected {");
    expect(
      unitRules(
        unitInput(objs, vals, {
          "flood-flood.speedLimit": "x",
          "flood-flood.uploadLimit": "y",
        }),
      )[0],
    ).toContain("expected {");
    expect(one({}, "flood-flood.nothing")).toContain(
      "flood-flood.nothing: pattern covers no number with a unit",
    );
  });
  it("reports a sample the inventory gives no number", () => {
    const objs = { "flood-flood.speedLimit": num("MB/s", "level") };
    for (const val of [null, "100"]) {
      expect(
        unitRules(unitInput(objs, { "flood-flood.speedLimit": val }, limit)),
      ).toEqual([
        'flood-flood.speedLimit: sample "flood-flood.speedLimit" has no number value in the inventory — the fixtures never produce one',
      ]);
    }
  });
  it("reports a file that is no object of entries", () => {
    expect(
      unitRules(
        unitInput({ "flood-flood.speedLimit": num("MB/s") }, {}, ["x"]),
      ),
    ).toEqual([
      'test/unit-values.json: expected { "<pattern>": { "id", "recorded", "unit", "file" } }',
    ]);
  });
  it("is not judged without recorded values or on one installation's live tree", () => {
    const objs = { "flood-flood.speedLimit": num("MB/s", "level") };
    const vals = { "flood-flood.speedLimit": 0.09765625 };
    const without = judgeValues({
      ...unitInput(objs, vals, undefined),
      unitValues: undefined,
    });
    expect(without.findings.filter((f) => f.rule === "unit-value")).toEqual([]);
    expect(without.notJudged.join()).toContain(
      "unit-value: no recorded values given (test/unit-values.json)",
    );
    const live = judgeValues(
      unitInput(objs, vals, limit, { partialTree: true }),
    );
    expect(live.findings.filter((f) => f.rule === "unit-value")).toEqual([]);
    expect(live.notJudged.join()).toContain(
      "unit-value: one installation's live values",
    );
  });
  it("follows the declarations of readable-values.json like every rule", () => {
    const objs = { "flood-flood.speedLimit": num("MB/s", "level") };
    const decl = {
      "flood-flood.speedLimit": {
        "unit-value": "The limit is a setting the device never reports back.",
      },
    };
    expect(
      unitRules(
        unitInput(
          objs,
          { "flood-flood.speedLimit": 100 },
          {},
          { declarations: decl },
        ),
      ),
    ).toEqual([]);
    expect(
      rules(
        unitInput(objs, { "flood-flood.speedLimit": 100 }, limit, {
          declarations: decl,
        }),
      ),
    ).toContain("declaration flood-flood.speedLimit");
    expect(
      rules(
        unitInput(objs, { "flood-flood.speedLimit": 100 }, undefined, {
          declarations: decl,
          unitValues: undefined,
        }),
      ),
    ).not.toContain("declaration flood-flood.speedLimit");
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
  it("names every option it reads in the usage line", () => {
    for (const option of [
      "--objects",
      "--states",
      "--objects-other-language",
      "--single-language",
      "--declarations",
      "--unit-values",
      "--partial-tree",
      "--full",
    ]) {
      expect(USAGE).toContain(option);
    }
  });
  it("--unit-values reads the recorded files from the adapter root and counts a missing file as one without entries", () => {
    const objects = {
      [`${NS}rx`]: { type: "device", common: { name: "rx" }, native: {} },
      [`${NS}rx.volume`]: state({
        type: "number",
        role: "level.volume",
        unit: "dB",
      }),
    };
    const o = write("o.json", objects);
    const s = write("s.json", {
      [`${NS}rx.volume`]: { val: -40.5, ack: true },
    });
    const base = ["--objects", o, "--states", s, "--single-language"];
    mkdirSync(join(dir, "test", "fixtures"), { recursive: true });
    writeFileSync(
      join(dir, "test", "fixtures", "status.json"),
      '{"actual_volume": {"value": -40.5}}',
    );
    const unitFile = join(dir, "test", "unit-values.json");
    expect(runValues([...base, "--unit-values", unitFile], out)).toBe(1);
    expect(lines.join("\n")).toContain("✗ unit-value: 1");
    writeFileSync(
      unitFile,
      JSON.stringify({
        "rx.volume": {
          id: "rx.volume",
          recorded: -40.5,
          unit: "dB",
          file: "test/fixtures/status.json",
        },
      }),
    );
    lines.length = 0;
    expect(runValues([...base, "--unit-values", unitFile], out)).toBe(0);
    lines.length = 0;
    expect(runValues(base, out)).toBe(0);
    expect(lines.join("\n")).toContain("not judged — unit-value");
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
