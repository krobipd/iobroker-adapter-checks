import type { Check, Finding } from "../types.js";
import { readJson } from "../util.js";

const INVENTORY = "test/objects.inventory.json";
const FLEET = "fleet.json";

/** The generation of the device-id rule a device object carries in `native.idScheme` once its id is final. */
export const ID_SCHEME = 3;

/** An id segment as the scheme builds it: lower-case letters and digits, runs joined by single hyphens. */
const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Shortest text that names where a user-named device gets its name. */
const MIN_SOURCE = 8;

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Device objects get one id scheme: the model and the last four characters of the device's own unit id
 * (`h61be-525f`, `rx-a2a-e7d3`), lower case with hyphens, marked with `native.idScheme: 3` once final.
 *
 * Applies to every adapter whose object inventory holds objects of type `device`: its `fleet.json` says where their
 * ids come from — `"deviceIds": "unit"` (hardware with its own unit id: the scheme) or
 * `"deviceIds": { "userNamed": "<where the user sets the name>" }` (the user names the entry in the counterpart or
 * the settings, and the id follows that name). An inventory with devices and no such entry is a finding: leaving the
 * entry out must not take an adapter out of the rule.
 */
export const deviceIdSchemeCheck: Check = {
  id: "device-id-scheme",
  title:
    "device ids follow the scheme: model + last four of the unit id, or the declared user-given name",
  run(adapterDir: string): Finding[] {
    const inventory = readJson<unknown>(adapterDir, INVENTORY);
    if (!isDict(inventory)) {
      return [];
    }
    const devices = Object.entries(inventory).filter(
      ([, obj]) => isDict(obj) && obj.type === "device",
    );
    if (devices.length === 0) {
      return [];
    }
    const fleet = readJson<unknown>(adapterDir, FLEET);
    const declared = isDict(fleet) ? fleet.deviceIds : undefined;
    if (declared === undefined) {
      return [
        {
          check: deviceIdSchemeCheck.id,
          file: FLEET,
          message: `the object tree holds ${devices.length} device object(s), but fleet.json does not say where their ids come from — "deviceIds": "unit" or { "userNamed": "<where the user sets the name>" }`,
          impact:
            "without the declaration no gate can tell whether the ids follow the scheme",
        },
      ];
    }
    if (isDict(declared)) {
      const source = declared.userNamed;
      if (
        Object.keys(declared).length === 1 &&
        typeof source === "string" &&
        source.trim().length >= MIN_SOURCE
      ) {
        return [];
      }
      return [
        {
          check: deviceIdSchemeCheck.id,
          file: FLEET,
          message: `"deviceIds" names no source — { "userNamed": "<where the user sets the name>" } with at least ${MIN_SOURCE} characters`,
        },
      ];
    }
    if (declared !== "unit") {
      return [
        {
          check: deviceIdSchemeCheck.id,
          file: FLEET,
          message: `"deviceIds" is ${JSON.stringify(declared)} — it is "unit" or { "userNamed": "<where the user sets the name>" }`,
        },
      ];
    }
    const findings: Finding[] = [];
    for (const [id, obj] of devices) {
      const segment = id.split(".").at(-1) ?? "";
      const native = isDict(obj) && isDict(obj.native) ? obj.native : {};
      if (native.idScheme !== ID_SCHEME) {
        findings.push({
          check: deviceIdSchemeCheck.id,
          file: INVENTORY,
          message: `device ${id} carries no native.idScheme ${ID_SCHEME} — its id is not final under the scheme (model + last four of the unit id)`,
          impact:
            "an id from an older rule moves again later, and the user's scripts, aliases and recordings point at the old one",
        });
      } else if (!SEGMENT.test(segment)) {
        findings.push({
          check: deviceIdSchemeCheck.id,
          file: INVENTORY,
          message: `device ${id}: "${segment}" is not lower-case letters and digits joined by hyphens (model + last four of the unit id, e.g. h61be-525f)`,
        });
      }
    }
    return findings;
  },
};
