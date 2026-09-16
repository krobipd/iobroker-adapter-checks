import { adapterCalls, laterOnSamePath } from "../adapter-api.js";
import type { Check, Finding } from "../types.js";
import { listSourceFiles, readText, repoPath } from "../util.js";

/** A whole-object write the repository checker refuses (S5054) — and its async twin, which it does not see. */
const WHOLE_WRITE = new Set(["setObject", "setObjectAsync"]);
/** Deleting an object, own or foreign. */
const DELETES = new Set([
  "delObject",
  "delObjectAsync",
  "delForeignObject",
  "delForeignObjectAsync",
]);
/** Creating or writing an object again after a delete. */
const RECREATES = new Set([
  "setObjectNotExists",
  "setObjectNotExistsAsync",
  "setForeignObjectNotExists",
  "setForeignObjectNotExistsAsync",
  "extendObject",
  "extendObjectAsync",
  "extendForeignObject",
  "extendForeignObjectAsync",
  "setObject",
  "setObjectAsync",
  "setForeignObject",
  "setForeignObjectAsync",
]);

const REWRITE =
  "to drop a key from an existing object read it, remove the key from the copy and write the copy back with setForeignObject(`${namespace}.${id}`, copy) — one write, the value and the enum memberships stay";

/**
 * An adapter that has to drop a key from an existing object (a stale `min`/`max`, an old
 * dropdown map in `common.states`, a leftover `native` entry) must not delete the object and
 * create it again, and must not write it whole with `setObject`.
 *
 * `extendObject` merges (`node.extend`): a key the stored object carries and the patch does not
 * survives every update, so a repair that has to REMOVE a key needs a whole-object write. Two
 * forms of that write cost the user something, measured on `@iobroker/js-controller-adapter`
 * 7.2.2 (`lib/adapter/adapter.js`):
 *
 * - `delObject` → `setObjectNotExists` / `extendObject`: `_delForeignObject` deletes the object,
 *   then `delForeignState(id)` for a state (the VALUE is gone) and `removeIdFromAllEnums` (the
 *   user's room and function assignments are gone) — and nothing the recreate writes brings
 *   them back. Between the two calls the object does not exist at all.
 * - `setObject` / `setObjectAsync`: the repository checker refuses `setObject` (S5054) as a
 *   method that overwrites what it should merge; `setObjectAsync` is the same call, deprecated
 *   in `@iobroker/types` 7.2.2 and merely invisible to the checker's method list — an evasion,
 *   not a fix.
 *
 * The form that does neither: `getObject` → remove the key from the copy →
 * `setForeignObject(fullId, copy)`. `_setObjectWithDefaultValue` writes the object and touches
 * neither the state value nor the enums; the full id is required because `setForeignObject`
 * does not prefix the namespace. Deleting an object that really goes away (a device that left,
 * a datapoint the adapter no longer creates) is not judged — only a delete of an id that the
 * same function creates again.
 *
 * Judged with the TypeScript compiler of the adapter: a delete and a create the code reaches
 * after it on the same path through the function (a `return` between them ends the path, a
 * `try` around the delete does not), same receiver, same first argument as written. A
 * whole-object write is judged on the adapter itself (`this` in a class that extends
 * `…Adapter`, `adapter`, `….adapter`); a port with the same method name on another receiver
 * is not. Without a loadable `typescript` the check reports that instead of staying silent.
 */
export const objectRewriteCheck: Check = {
  id: "object-rewrite",
  title:
    "an object loses a key by a copy written with setForeignObject, not by delete + create or setObject",
  run(adapterDir: string): Finding[] {
    const findings: Finding[] = [];
    for (const file of listSourceFiles(adapterDir)) {
      const rel = repoPath(adapterDir, file);
      const calls = adapterCalls(readText(adapterDir, rel) ?? "", rel);
      if (!calls) {
        // Fail closed: a standard that cannot be judged is a finding, not silence.
        return [
          {
            check: objectRewriteCheck.id,
            file: rel,
            message:
              "the sources could not be parsed: no `typescript` module can be loaded next to this package",
            impact:
              "the check reads the sources with the adapter's own compiler (a dev dependency of every TypeScript adapter) — until it is installed this standard is not judged",
          },
        ];
      }
      for (const call of calls) {
        if (call.onAdapter && WHOLE_WRITE.has(call.name)) {
          findings.push({
            check: objectRewriteCheck.id,
            file: rel,
            line: call.line,
            message: `the adapter writes an object whole with ${call.name}(${call.args[0] ?? ""})`,
            impact: `the repository checker refuses setObject (S5054) and setObjectAsync is the same call, deprecated and merely unseen by its method list; a new object is created with setObjectNotExists or extendObject, and ${REWRITE}`,
          });
        }
        if (!DELETES.has(call.name) || call.args.length === 0) {
          continue;
        }
        const recreate = laterOnSamePath(
          calls,
          call,
          (c) =>
            c.receiver === call.receiver &&
            RECREATES.has(c.name) &&
            c.args[0] === call.args[0],
        );
        if (recreate) {
          findings.push({
            check: objectRewriteCheck.id,
            file: rel,
            line: call.line,
            message: `the adapter deletes ${call.args[0]} with ${call.name} and creates it again with ${recreate.name} (line ${recreate.line})`,
            impact: `the delete drops the value of a state object and removes the id from every enum (the user's room and function assignments), and nothing the recreate writes brings them back; ${REWRITE}`,
          });
        }
      }
    }
    return findings;
  },
};
