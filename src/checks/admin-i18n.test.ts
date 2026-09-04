import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_LANGUAGES, adminI18nCheck } from "./admin-i18n.js";

describe("admin-i18n", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "checks-i18n-"));
    mkdirSync(join(dir, "admin"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const settings = (obj: unknown, name = "jsonConfig.json"): void =>
    writeFileSync(join(dir, "admin", name), JSON.stringify(obj));
  const flat = (lang: string, dict: Record<string, string>): void => {
    mkdirSync(join(dir, "admin", "i18n"), { recursive: true });
    writeFileSync(join(dir, "admin", "i18n", `${lang}.json`), JSON.stringify(dict));
  };
  const allFlat = (dict: Record<string, string>): void => {
    for (const l of ADMIN_LANGUAGES) flat(l, dict);
  };

  it("accepts a fully translated settings page", () => {
    settings({ items: { host: { type: "text", label: "hostLabel" } } });
    allFlat({ hostLabel: "Host" });
    expect(adminI18nCheck.run(dir)).toEqual([]);
  });

  it("names the languages that are missing", () => {
    settings({ items: { host: { label: "hostLabel" } } });
    flat("en", { hostLabel: "Host" });
    flat("de", { hostLabel: "Host" });
    const messages = adminI18nCheck.run(dir).map(f => f.message);
    expect(messages.join(" ")).toContain("missing languages");
    expect(messages.join(" ")).toContain("ru");
  });

  it("reports a language that misses individual texts", () => {
    settings({ items: { a: { label: "one" }, b: { label: "two" } } });
    allFlat({ one: "1", two: "2" });
    flat("pl", { one: "1" });
    const finding = adminI18nCheck.run(dir).find(f => f.file.includes("pl"));
    expect(finding?.message).toContain("missing 1 translation");
    expect(finding?.message).toContain("two");
  });

  it("reports both i18n layouts side by side", () => {
    settings({ items: {} });
    flat("en", {});
    mkdirSync(join(dir, "admin", "i18n", "de"), { recursive: true });
    writeFileSync(join(dir, "admin", "i18n", "de", "translations.json"), "{}");
    expect(adminI18nCheck.run(dir)[0]?.message).toContain("both i18n layouts");
  });

  it("reports a manifest that names the wrong dialect", () => {
    settings({ items: {} }, "jsonConfig.json");
    writeFileSync(
      join(dir, "io-package.json"),
      JSON.stringify({ common: { adminUI: { config: "json5" } } }),
    );
    allFlat({});
    expect(adminI18nCheck.run(dir)[0]?.message).toContain("json5");
  });

  it("reports a known mistranslation", () => {
    settings({ items: { a: { label: "cancel" } } });
    allFlat({ cancel: "Cancel" });
    flat("pl", { cancel: "Poronić" });
    const finding = adminI18nCheck.run(dir).find(f => f.message.includes("Poronić"));
    expect(finding).toBeDefined();
  });

  it("reports the adapter's own name run through a translator", () => {
    // ParcelApp shipped as "Paketapp"/"paquetapp"/"paccoapp" — the name is a name.
    settings({ items: { a: { label: "intro" } } });
    allFlat({ intro: "ParcelApp shows your parcels" });
    flat("de", { intro: "Paketapp zeigt deine Pakete" });
    expect(adminI18nCheck.run(dir).some(f => f.message.includes("Paketapp"))).toBe(true);
  });

  it("does not read `Install` as the barn mistranslation", () => {
    // Case-sensitive on purpose: "Install" carries "stall", not "Stall".
    settings({ items: { a: { label: "intro" } } });
    allFlat({ intro: "Install the adapter first" });
    expect(adminI18nCheck.run(dir).some(f => f.message.includes("Stall"))).toBe(false);
  });

  it("says so when the settings page has texts but no translation files", () => {
    settings({ items: { a: { label: "one" } } });
    expect(adminI18nCheck.run(dir)[0]?.message).toContain("admin/i18n is missing");
  });

  it("tolerates the relaxed dialect with whole-line comments", () => {
    writeFileSync(
      join(dir, "admin", "jsonConfig.json5"),
      '{\n  // a comment\n  "items": { "a": { "label": "one" } },\n}',
    );
    allFlat({ one: "1" });
    expect(adminI18nCheck.run(dir)).toEqual([]);
  });

  it("says it could not scan when inline comments defeat the parser", () => {
    writeFileSync(
      join(dir, "admin", "jsonConfig.json5"),
      '{\n  "items": { "a": { "label": "one" } }, // inline\n}',
    );
    allFlat({ one: "1" });
    expect(adminI18nCheck.run(dir)[0]?.message).toContain("were not scanned");
  });

  it("stays silent for an adapter without a settings page", () => {
    expect(adminI18nCheck.run(dir)).toEqual([]);
  });
});

describe("admin-i18n key parity against en", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i18n-parity-"));
    mkdirSync(join(dir, "admin", "i18n"), { recursive: true });
    writeFileSync(
      join(dir, "io-package.json"),
      JSON.stringify({ common: { name: "demo", adminUI: { config: "json" } } }),
    );
    // Der Check haengt an der Einstellungsseite — ohne sie steigt er aus.
    writeFileSync(
      join(dir, "admin", "jsonConfig.json"),
      JSON.stringify({ items: { greeting: { type: "text", label: "greeting" } } }),
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const lang = (code: string, dict: Record<string, string>): void => {
    writeFileSync(join(dir, "admin", "i18n", `${code}.json`), JSON.stringify(dict));
  };

  const messages = (): string[] =>
    adminI18nCheck.run(dir).map((f) => f.message);

  it("stays silent when every language carries the same keys", () => {
    for (const code of ADMIN_LANGUAGES) {
      lang(code, { greeting: "x", farewell: "y" });
    }
    expect(messages().filter((m) => m.includes("key(s)"))).toEqual([]);
  });

  it("reports a key that english has and another language lacks", () => {
    for (const code of ADMIN_LANGUAGES) {
      lang(code, code === "de" ? { greeting: "x" } : { greeting: "x", farewell: "y" });
    }
    expect(messages().some((m) => m.includes("missing here") && m.includes("farewell"))).toBe(true);
  });

  it("reports a key that exists only outside english", () => {
    for (const code of ADMIN_LANGUAGES) {
      lang(code, code === "de" ? { greeting: "x", leftover: "z" } : { greeting: "x" });
    }
    expect(messages().some((m) => m.includes("not in en") && m.includes("leftover"))).toBe(true);
  });

  it("does not compare english against itself", () => {
    for (const code of ADMIN_LANGUAGES) {
      lang(code, { greeting: "x" });
    }
    expect(messages().some((m) => m.includes("admin/i18n/en.json") && m.includes("key(s)"))).toBe(false);
  });
});
