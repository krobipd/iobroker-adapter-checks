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
    const supported = asObject(asObject(iopkg.common).supportedMessages);
    if (!supported.stopInstance) {
      return [];
    }
    return [
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
