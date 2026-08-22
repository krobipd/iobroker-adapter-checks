import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check, Finding } from "../types.js";
import { readJson, readText } from "../util.js";

/** The languages an ioBroker admin page is expected to carry. */
export const ADMIN_LANGUAGES: readonly string[] = [
  "en",
  "de",
  "ru",
  "pt",
  "nl",
  "fr",
  "it",
  "es",
  "pl",
  "uk",
  "zh-cn",
];

/** Keys in the settings description whose value the user actually reads. */
const USER_FACING_KEYS = new Set([
  "label",
  "text",
  "tooltip",
  "placeholder",
  "help",
  "title",
  "name",
]);

/** A value that looks like a translation key: no spaces, no punctuation, short. */
const TRANSLATION_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

/**
 * Machine translations that are wrong in a way a reader notices immediately.
 *
 * Every entry stands for one incident that shipped: "Abort" turned into the medical
 * sense in Polish, French, Spanish and German; "stall" became the German word for a
 * barn; and a translation service happily translated an adapter's own name, so
 * "ParcelApp" reached users as "Paketapp" / "paquetapp" / "paccoapp". Matched
 * case-sensitively as substrings — "Install" does not contain "Stall".
 */
const MISTRANSLATIONS = [
  "Poronić",
  "Avorter",
  "Abortar",
  "Fehlgeburt",
  "Lüszel",
  "Stall",
  "Paketapp",
  "paquetapp",
  "paccoapp",
];

/**
 * Collect the translation keys from a settings description.
 *
 * @param value any part of the parsed structure
 * @param out collected keys
 * @returns the collected keys
 */
function collectKeys(
  value: unknown,
  out: Set<string> = new Set(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) {
      collectKeys(v, out);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (USER_FACING_KEYS.has(k) && typeof v === "string") {
        if (TRANSLATION_KEY_RE.test(v) && v.length <= 80) {
          out.add(v);
        }
      }
      collectKeys(v, out);
    }
  }
  return out;
}

/** What the settings description is called and how it was parsed. */
interface ConfigRead {
  filename: string;
  keys: Set<string>;
  problem?: string;
}

/**
 * Read the settings description, tolerating the relaxed JSON dialect adapters may use.
 *
 * @param adapterDir the adapter repository root
 * @returns the file name and its translation keys, or undefined when there is none
 */
function readSettingsConfig(adapterDir: string): ConfigRead | undefined {
  for (const filename of ["jsonConfig.json", "jsonConfig.json5"]) {
    const raw = readText(adapterDir, join("admin", filename));
    if (raw === undefined) {
      continue;
    }
    // Strip trailing commas and whole-line comments; that covers the relaxed dialect
    // as far as key collection needs it.
    const cleaned = raw
      .replace(/,(\s*[}\]])/g, "$1")
      .replace(/^\s*\/\/.*$/gm, "");
    try {
      return { filename, keys: collectKeys(JSON.parse(cleaned) as unknown) };
    } catch {
      if (filename.endsWith(".json5")) {
        // Inline comments defeat the line-based strip — say so instead of guessing.
        return {
          filename,
          keys: new Set(),
          problem: `${filename}: inline comments, translation keys were not scanned`,
        };
      }
      return {
        filename,
        keys: new Set(),
        problem: `${filename}: is not valid JSON`,
      };
    }
  }
  return undefined;
}

/**
 * The settings page is translated in every language the adapter ships.
 *
 * A missing key does not fail anything — the admin simply shows the raw key or the
 * English text, and the user is left with a half-translated dialog.
 */
export const adminI18nCheck: Check = {
  id: "admin-i18n",
  title: "the settings page is translated in every shipped language",
  run(adapterDir: string): Finding[] {
    const findings: Finding[] = [];
    const add = (message: string, file: string): void => {
      findings.push({ check: adminI18nCheck.id, file, message });
    };

    const config = readSettingsConfig(adapterDir);
    if (!config) {
      return findings;
    }
    if (config.problem) {
      add(config.problem, `admin/${config.filename}`);
    }

    // The manifest has to name the dialect that is actually present.
    const declared = readJson<{ common?: { adminUI?: { config?: string } } }>(
      adapterDir,
      "io-package.json",
    )?.common?.adminUI?.config;
    const hasJson5 = existsSync(join(adapterDir, "admin", "jsonConfig.json5"));
    if (declared === "json" && config.filename.endsWith(".json5")) {
      add(
        'adminUI.config says "json" but only jsonConfig.json5 exists',
        "io-package.json",
      );
    } else if (declared === "json5" && !hasJson5) {
      add(
        'adminUI.config says "json5" but only jsonConfig.json exists',
        "io-package.json",
      );
    }

    const i18nDir = join(adapterDir, "admin", "i18n");
    let entries: string[];
    try {
      entries = readdirSync(i18nDir);
    } catch {
      if (config.keys.size > 0) {
        add(
          `the settings page has ${config.keys.size} translatable texts but admin/i18n is missing`,
          "admin/i18n",
        );
      }
      return findings;
    }

    // Two layouts exist in the wild: <lang>/translations.json and <lang>.json.
    const nested = ADMIN_LANGUAGES.filter((l) =>
      existsSync(join(i18nDir, l, "translations.json")),
    );
    const flat = ADMIN_LANGUAGES.filter((l) => entries.includes(`${l}.json`));
    if (nested.length > 0 && flat.length > 0) {
      add(
        "both i18n layouts are present (<lang>/translations.json and <lang>.json)",
        "admin/i18n",
      );
      return findings;
    }
    const available = nested.length > 0 ? nested : flat;
    if (available.length === 0) {
      if (config.keys.size > 0) {
        add(
          `the settings page has ${config.keys.size} translatable texts but no i18n files were found`,
          "admin/i18n",
        );
      }
      return findings;
    }

    const missingLanguages = ADMIN_LANGUAGES.filter(
      (l) => !available.includes(l),
    );
    if (missingLanguages.length > 0) {
      add(`missing languages: ${missingLanguages.join(", ")}`, "admin/i18n");
    }

    for (const lang of available) {
      const file =
        nested.length > 0
          ? join(i18nDir, lang, "translations.json")
          : join(i18nDir, `${lang}.json`);
      const rel =
        nested.length > 0
          ? `admin/i18n/${lang}/translations.json`
          : `admin/i18n/${lang}.json`;
      let dict: Record<string, unknown>;
      try {
        dict = JSON.parse(readFileSync(file, "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        add("cannot be parsed", rel);
        continue;
      }
      if (config.keys.size > 0) {
        const missing = [...config.keys].filter((k) => !(k in dict)).sort();
        if (missing.length > 0) {
          const sample = missing.slice(0, 3).join(", ");
          add(
            `missing ${missing.length} translation(s): ${sample}${missing.length > 3 ? "…" : ""}`,
            rel,
          );
        }
      }
      for (const [key, value] of Object.entries(dict)) {
        if (typeof value !== "string") {
          continue;
        }
        for (const wrong of MISTRANSLATIONS) {
          if (value.includes(wrong)) {
            add(`"${key}" carries the mistranslation "${wrong}"`, rel);
          }
        }
      }
    }

    return findings;
  },
};
