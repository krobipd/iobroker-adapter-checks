import type { Check, Finding } from "../types.js";
import { readJson } from "../util.js";

/** The two lists that tell js-controller which native settings are secret. */
const FIELDS = ["encryptedNative", "protectedNative"] as const;

/**
 * `encryptedNative` and `protectedNative` belong at the root of io-package.json.
 *
 * Placed under `common` they are simply ignored: passwords and tokens are then stored and
 * shown in clear text, and nothing in the log says so. The repository checker notices the
 * symptom (it reads the lists from the root and reports the fields as unlisted) but names
 * the wrong cause, so this check calls it out directly.
 */
export const secretFieldsCheck: Check = {
  id: "secret-fields",
  title: "encryptedNative / protectedNative sit at the root of io-package.json",
  run(adapterDir: string): Finding[] {
    const iopkg = readJson<Record<string, unknown>>(adapterDir, "io-package.json");
    if (!iopkg) {
      return [];
    }
    const rawCommon = iopkg["common"];
    // A broken manifest can carry anything here; `in` throws on a non-object.
    const common: Record<string, unknown> =
      typeof rawCommon === "object" && rawCommon !== null ? (rawCommon as Record<string, unknown>) : {};
    const findings: Finding[] = [];
    for (const field of FIELDS) {
      if (field in common) {
        findings.push({
          check: secretFieldsCheck.id,
          file: "io-package.json",
          message: `"${field}" is nested under "common" — it must sit at the root`,
          impact: "js-controller ignores it there, so those settings are stored unencrypted",
        });
      }
    }
    return findings;
  },
};
