import { adapterCalls, laterOnSamePath } from "../adapter-api.js";
import type { Check, Finding } from "../types.js";
import { listSourceFiles, readText, repoPath } from "../util.js";

/** Deleting a state value, own or foreign. */
const STATE_DELETES = new Set([
  "delState",
  "delStateAsync",
  "delForeignState",
  "delForeignStateAsync",
]);
/** Deleting an object, own or foreign. */
const OBJECT_DELETES = new Set([
  "delObject",
  "delObjectAsync",
  "delForeignObject",
  "delForeignObjectAsync",
]);

/**
 * An object delete drops the state value itself — a `delState` of the same id beside it is a
 * second removal of something the controller already removed.
 *
 * `delObject` / `delForeignObject` read the object, delete it and, when its type is `state`,
 * delete the value with `delForeignState` and take the id out of every enum
 * (`@iobroker/js-controller-adapter` `_delForeignObject`, the same for every id of a
 * `{ recursive: true }` delete in `_deleteObjects`). That has been the controller's behaviour
 * since js-controller 1.x (`lib/adapter.js`, 2019). An adapter that calls `delState(id)` right
 * before or after `delObject(id)` pays a second round trip to the states database per object,
 * and usually carries a comment that tells the next reader the opposite of what the controller
 * does ("delObject leaves the value behind") — which then spreads to the next cleanup routine.
 *
 * Judged with the TypeScript compiler of the adapter: a state delete and an object delete on
 * the same receiver, with the same first argument as written, that the code reaches one after
 * the other on the same path through the function (either order; a `return` between them ends
 * the path). Only calls on the adapter itself count — `this` in a class extending
 * `…Adapter`, `adapter`, `….adapter`; a states-database client of its own (`objects.delObject`
 * of a controller-internal port) is not the adapter API and is not judged. A `delState` on its
 * own — an orphan value whose object is already gone — is exactly what `delState` is for and is
 * not reported. Without a loadable `typescript` the check reports that instead of staying silent.
 */
export const objectDeleteDropsStateCheck: Check = {
  id: "object-delete-drops-state",
  title:
    "an object delete drops the state value itself — no delState beside delObject of the same id",
  run(adapterDir: string): Finding[] {
    const findings: Finding[] = [];
    for (const file of listSourceFiles(adapterDir)) {
      const rel = repoPath(adapterDir, file);
      const calls = adapterCalls(readText(adapterDir, rel) ?? "", rel);
      if (!calls) {
        // Fail closed: a standard that cannot be judged is a finding, not silence.
        return [
          {
            check: objectDeleteDropsStateCheck.id,
            file: rel,
            message:
              "the sources could not be parsed: no `typescript` module can be loaded next to this package",
            impact:
              "the check reads the sources with the adapter's own compiler (a dev dependency of every TypeScript adapter) — until it is installed this standard is not judged",
          },
        ];
      }
      const reported = new Set<number>();
      for (const call of calls) {
        if (!call.onAdapter || call.args.length === 0) {
          continue;
        }
        const fromState = STATE_DELETES.has(call.name);
        if (!fromState && !OBJECT_DELETES.has(call.name)) {
          continue;
        }
        const wanted = fromState ? OBJECT_DELETES : STATE_DELETES;
        const other = laterOnSamePath(
          calls,
          call,
          (c) =>
            c.receiver === call.receiver &&
            wanted.has(c.name) &&
            c.args[0] === call.args[0],
        );
        if (!other) {
          continue;
        }
        const stateCall = fromState ? call : other;
        const objectCall = fromState ? other : call;
        if (reported.has(stateCall.line)) {
          continue;
        }
        reported.add(stateCall.line);
        findings.push({
          check: objectDeleteDropsStateCheck.id,
          file: rel,
          line: stateCall.line,
          message: `the adapter deletes the state ${stateCall.args[0]} with ${stateCall.name} beside ${objectCall.name}(${objectCall.args[0]}) (line ${objectCall.line})`,
          impact:
            "js-controller deletes the value of a state object together with the object (`_delForeignObject` → `delForeignState`, plus the enum memberships — since 1.x); the extra delete is a second round trip per object and a comment that misleads the next cleanup routine. One delete of the object is the whole removal",
        });
      }
    }
    return findings.sort(
      (a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0),
    );
  },
};
