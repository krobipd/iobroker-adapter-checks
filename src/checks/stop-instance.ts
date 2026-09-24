import type { Check, Finding } from "../types.js";
import { readJson } from "../util.js";

/**
 * `common.supportedMessages.stopInstance` must not be set.
 *
 * With the entry present the host sends a message on shutdown and then kills the process
 * unconditionally — `onUnload` never runs, so every write meant for shutdown is dead code.
 * Measured against js-controller 7.2.2: the log says `terminated due to SIGKILL` instead of
 * `ADAPTER_REQUESTED_TERMINATION`.
 *
 * What the user sees: devices stay green in the object tree while the instance is stopped,
 * because the adapter never got to write their real state.
 *
 * `deviceManager` under the same key is unaffected and stays allowed — it is a positive
 * list, and only this one entry changes how the host terminates the process.
 *
 * The second finding is the correction that goes wrong: `supportedMessages` is a POSITIVE list. js-controller
 * (`isMessageboxSupported`, packages/adapter/src/lib/adapter/utils.ts) treats the messagebox as supported only
 * when the object carries a value other than `false` — `{ stopInstance: false }` (or `{}`) in the manifest turns
 * the messagebox OFF, even next to `messagebox: true`, and every `sendTo` to the adapter goes nowhere. The fix is
 * to delete the key, never to write `false` into it.
 */
export const stopInstanceCheck: Check = {
  id: "stop-instance",
  title: "common.supportedMessages.stopInstance is not set",
  run(adapterDir: string): Finding[] {
    const iopkg = readJson<Record<string, unknown>>(
      adapterDir,
      "io-package.json",
    );
    if (!iopkg) {
      return [];
    }
    const asObject = (v: unknown): Record<string, unknown> =>
      typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
    const raw = asObject(iopkg.common).supportedMessages;
    const supported = asObject(raw);
    const findings: Finding[] = [];
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Object.values(supported).some((v) => v !== false)
    ) {
      findings.push({
        check: stopInstanceCheck.id,
        file: "io-package.json",
        message: `common.supportedMessages is ${JSON.stringify(raw)} — no entry other than false`,
        impact:
          "js-controller treats the messagebox as unsupported (isMessageboxSupported) — every sendTo to the " +
          "adapter goes nowhere; delete the key instead of writing false into it",
      });
    }
    if (!supported.stopInstance) {
      return findings;
    }
    return [
      ...findings,
      {
        check: stopInstanceCheck.id,
        file: "io-package.json",
        message: "common.supportedMessages.stopInstance is set",
        impact:
          "the host kills the process instead of asking it to stop — onUnload never runs " +
          "and every shutdown write is lost",
      },
    ];
  },
};
