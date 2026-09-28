import { adapterProperties } from "../adapter-api.js";
import type { Check, Finding } from "../types.js";
import { listSourceFiles, readText, repoPath } from "../util.js";

/** The adapter fields js-controller copies from `system.config` — only on request. */
const SYSTEM_CONFIG_FIELDS = new Set([
  "dateFormat",
  "isFloatComma",
  "language",
  "longitude",
  "latitude",
]);

/**
 * The adapter reads `dateFormat`, `isFloatComma`, `language`, `longitude` or `latitude` only
 * when it asked js-controller to fill them.
 *
 * js-controller copies these five fields from `system.config` into the adapter object only
 * under the adapter option `useFormatDate: true` (`@iobroker/js-controller-adapter` 7.2.2,
 * `build/cjs/lib/adapter/adapter.js`: `if (this._options.useFormatDate) { … this.language =
 * data.common.language … }`; the declarations say "only available if requested via
 * AdapterOptions `useFormatDate`"). `systemConfig: true` does not do it — that option fills
 * `this.systemConfig` from `iobroker.json`. Without the option every one of the five stays
 * `undefined`: an adapter that reads `this.language` falls back to its default in silence —
 * measured 2026-09-28 on an adapter whose value labels were English in every system language
 * and which never sent an `Accept-Language` to its cloud, and on a core adapter that picks
 * `name[this.language || 'en']`.
 *
 * Judged are reads on the adapter itself (`this` in a class extending `…Adapter`, `adapter`,
 * `….adapter`). Nothing is reported when the sources set `useFormatDate: true` in an object
 * literal, and a field the adapter declares or assigns itself is its own — a class with
 * `public language = 'en'` that reads `system.config` on its own is right.
 */
export const systemConfigFieldsCheck: Check = {
  id: "system-config-fields",
  title:
    "system.config fields on the adapter are read only with useFormatDate: true",
  run(adapterDir: string): Finding[] {
    const perFile: {
      rel: string;
      props: NonNullable<ReturnType<typeof adapterProperties>>;
    }[] = [];
    for (const file of listSourceFiles(adapterDir)) {
      const rel = repoPath(adapterDir, file);
      const props = adapterProperties(readText(adapterDir, rel) ?? "", rel);
      if (!props) {
        return [];
      }
      perFile.push({ rel, props });
    }
    if (perFile.some(({ props }) => props.trueFlags.has("useFormatDate"))) {
      return [];
    }
    const own = new Set<string>();
    for (const { props } of perFile) {
      for (const name of props.declaredOnAdapter) {
        own.add(name);
      }
      for (const access of props.accesses) {
        if (access.onAdapter && access.write) {
          own.add(access.name);
        }
      }
    }
    const findings: Finding[] = [];
    const seen = new Set<string>();
    for (const { rel, props } of perFile) {
      for (const access of props.accesses) {
        const key = `${rel}:${access.line}:${access.receiver}.${access.name}`;
        if (
          !access.onAdapter ||
          access.write ||
          !SYSTEM_CONFIG_FIELDS.has(access.name) ||
          own.has(access.name) ||
          seen.has(key)
        ) {
          continue;
        }
        seen.add(key);
        findings.push({
          check: systemConfigFieldsCheck.id,
          file: rel,
          line: access.line,
          message: `${access.receiver}.${access.name} is read, but no adapter option useFormatDate: true asks js-controller to fill it`,
          impact:
            "without the option js-controller leaves the field undefined and the adapter falls back in silence " +
            "(labels in English, no location) — pass useFormatDate: true to the Adapter constructor or read system.config itself",
        });
      }
    }
    return findings;
  },
};
