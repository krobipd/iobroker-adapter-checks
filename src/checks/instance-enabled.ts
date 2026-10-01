import type { Check, Finding } from "../types.js";
import { readJson } from "../util.js";

/**
 * `common.enabled` is `false` — a new instance starts disabled.
 *
 * The object schema (`ioBroker.docs`, `docs/en/dev/objectsschema.md`: "**mandatory** [true/false] value should be
 * false so new instances are disabled by default") and js-controller's own io-package schema ("Value should be false
 * so new instances are disabled by default") say the same; the user enables an instance after configuring it. An
 * update never touches the setting of an existing instance: js-controller 7.2.2 `setupUpload.ts` `extendCommon` keeps
 * `enabled` of the installed instance, so the value only reaches instances created after the change.
 */
export const instanceEnabledCheck: Check = {
  id: "instance-enabled",
  title: "common.enabled is false, so a new instance starts disabled",
  run(adapterDir: string): Finding[] {
    const iopkg = readJson<Record<string, unknown>>(
      adapterDir,
      "io-package.json",
    );
    if (!iopkg) {
      return [];
    }
    const common = iopkg.common;
    const enabled =
      typeof common === "object" && common !== null
        ? (common as Record<string, unknown>).enabled
        : undefined;
    if (enabled === false) {
      return [];
    }
    return [
      {
        check: instanceEnabledCheck.id,
        file: "io-package.json",
        message:
          enabled === undefined
            ? "common.enabled is missing — it is mandatory and should be false"
            : `common.enabled is ${JSON.stringify(enabled)} — it should be false`,
        impact:
          "a new instance starts before the user configured it; existing instances keep their own setting on update",
      },
    ];
  },
};
