import type { Check, Finding } from "../types.js";
import {
  listSourceFiles,
  readJson,
  readText,
  repoPath,
  stripTsComments,
} from "../util.js";

/** A source line that opens a socket: an HTTP/TCP server, a `listen()`, a datagram socket. */
const LISTENER = /\bcreateServer\s*\(|\.listen\s*\(|\bcreateSocket\s*\(/;

const PROTOCOLS = new Set(["tcp", "udp"]);
const ROLES = new Set(["primary", "secondary", "shared", "perDevice"]);
/** Keys that carried a listen address before the standard; the admin never read them. */
const LEGACY_BIND_KEYS = ["bindAddress", "BIND"];
const FLEET = "fleet.json";
const MANIFEST = "io-package.json";
const SETTINGS = "admin/jsonConfig.json";

interface PortEntry {
  key: string;
  protocol: string;
  role: string;
  fixed?: number;
}

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isPortNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;

/**
 * Public keys of a declaration object — keys starting with `_` are comments.
 *
 * @param o the declaration object
 * @returns its keys without the comment keys
 */
const publicKeys = (o: Dict): string[] =>
  Object.keys(o).filter((k) => !k.startsWith("_"));

/**
 * The settings field stored under `attr`, wherever the form nests it (tabs, panels,
 * accordions all carry `items`). Table columns are arrays and are not fields.
 *
 * @param node the jsonConfig subtree
 * @param attr the native key the field writes
 * @returns the field definition, or undefined
 */
function findField(node: unknown, attr: string): Dict | undefined {
  if (!isDict(node)) {
    return undefined;
  }
  const items = node.items;
  if (isDict(items)) {
    const direct = items[attr];
    if (isDict(direct) && typeof direct.type === "string") {
      return direct;
    }
    for (const child of Object.values(items)) {
      const hit = findField(child, attr);
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
}

/**
 * The first source line below `src/` that opens a socket, comments removed.
 *
 * @param adapterDir the adapter repository root
 * @returns file (repo-relative) and 1-based line, or undefined when nothing listens
 */
function firstListener(
  adapterDir: string,
): { file: string; line: number } | undefined {
  for (const abs of listSourceFiles(adapterDir)) {
    const rel = repoPath(adapterDir, abs);
    const text = readText(adapterDir, rel);
    if (text === undefined) {
      continue;
    }
    const lines = stripTsComments(text).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (LISTENER.test(lines[i] ?? "")) {
        return { file: rel, line: i + 1 };
      }
    }
  }
  return undefined;
}

/**
 * An adapter that opens a port declares it — and declares it the way the admin reads it.
 *
 * The admin's port-conflict check ("Port is already used by X") only sees instances on the
 * same host that carry BOTH `native.port` and `native.bind`; measured on the 801 adapters of
 * the official repository, 145 declare `native.port` and only 38 also `bind`. An adapter that
 * stores its listen address under any other key (`host`, `bindAddress`, `networkInterface`)
 * is invisible: a user who puts `web` on the same port gets no warning, and a second instance
 * of the adapter on the same host fails only at runtime.
 *
 * The declaration lives in the adapter's `fleet.json` (`listenPorts`): every port the adapter
 * opens, with `key` (the native key; an opaque path for `perDevice`), `protocol` (tcp|udp),
 * `role` — `primary` (exactly one: the number in `native.port`), `secondary` (a further own
 * port), `shared` (deliberately shared, e.g. SSDP 1900 — never `native.port`, the admin knows
 * no protocol and would warn every UPnP user), `perDevice` (one port per table row) — and an
 * optional `fixed` protocol port. This check reads the declaration and holds the manifest and
 * the settings form to it: `native.port` a number, `native.bind` the only listen-address key,
 * the port field of type `port` (disabled with `min = max` when the protocol fixes it), the
 * bind field of type `ip` listening on all ports — and a client adapter, whose `native.port`
 * is the port of the peer, must not carry `bind` at all.
 */
export const listenPortDeclarationCheck: Check = {
  id: "listen-port-declaration",
  title:
    "a listening adapter declares its ports (fleet.json listenPorts) as native.port + native.bind",
  run(adapterDir: string): Finding[] {
    const findings: Finding[] = [];
    const report = (
      file: string,
      message: string,
      impact: string,
      line?: number,
    ): void => {
      findings.push({
        check: listenPortDeclarationCheck.id,
        file,
        message,
        impact,
        ...(line ? { line } : {}),
      });
    };

    const fleet = readJson<Dict>(adapterDir, FLEET);
    const rawPorts = isDict(fleet) ? fleet.listenPorts : undefined;
    const listener = firstListener(adapterDir);

    // R3 — shape of the declaration
    const entries: PortEntry[] = [];
    if (rawPorts !== undefined) {
      if (!Array.isArray(rawPorts)) {
        report(
          FLEET,
          "listenPorts is not a list of {key, protocol, role[, fixed]} entries",
          "the declaration cannot be read, so nothing below is checked",
        );
      } else {
        rawPorts.forEach((entry, i) => {
          const where = `listenPorts[${i}]`;
          if (!isDict(entry)) {
            report(
              FLEET,
              `${where} is not an object ({key, protocol, role[, fixed]})`,
              "the entry cannot be read",
            );
            return;
          }
          const unknown = publicKeys(entry).filter(
            (k) => !["key", "protocol", "role", "fixed"].includes(k),
          );
          if (unknown.length) {
            report(
              FLEET,
              `${where} carries unknown keys: ${unknown.join(", ")} (allowed: key, protocol, role, fixed)`,
              "a typo would silently declare nothing",
            );
          }
          const { key, protocol, role, fixed } = entry;
          let ok = true;
          if (typeof key !== "string" || !key) {
            report(
              FLEET,
              `${where}.key is missing or not a non-empty string (the native key of the port)`,
              "the port cannot be matched to the manifest",
            );
            ok = false;
          }
          if (typeof protocol !== "string" || !PROTOCOLS.has(protocol)) {
            report(
              FLEET,
              `${where}.protocol must be "tcp" or "udp", not ${JSON.stringify(protocol)}`,
              "the declaration is ambiguous",
            );
            ok = false;
          }
          if (typeof role !== "string" || !ROLES.has(role)) {
            report(
              FLEET,
              `${where}.role must be primary, secondary, shared or perDevice, not ${JSON.stringify(role)}`,
              "the admin-facing port cannot be told from a shared one",
            );
            ok = false;
          }
          if (fixed !== undefined && !isPortNumber(fixed)) {
            report(
              FLEET,
              `${where}.fixed must be a port number 1..65535, not ${JSON.stringify(fixed)}`,
              "a fixed port that is not a number cannot be held against the manifest",
            );
            ok = false;
          }
          if (ok) {
            entries.push({
              key: key as string,
              protocol: protocol as string,
              role: role as string,
              ...(fixed !== undefined ? { fixed: fixed as number } : {}),
            });
          }
        });
      }
    }
    const keys = entries.map((e) => e.key);
    for (const dup of [
      ...new Set(keys.filter((k, i) => keys.indexOf(k) !== i)),
    ]) {
      report(
        FLEET,
        `listenPorts names the key "${dup}" twice`,
        "one port cannot play two roles",
      );
    }
    const primaries = entries.filter((e) => e.role === "primary");
    if (primaries.length > 1) {
      report(
        FLEET,
        `listenPorts declares ${primaries.length} primary ports — exactly one becomes native.port`,
        "the admin reads a single native.port per instance",
      );
    }
    if (!primaries.length && entries.some((e) => e.role === "secondary")) {
      report(
        FLEET,
        "listenPorts declares a secondary port but no primary one",
        "a further port needs a main port the admin can check",
      );
    }
    for (const e of entries) {
      if (e.role !== "primary" && e.key === "port") {
        report(
          FLEET,
          `listenPorts uses the key "port" for a ${e.role} port — "port" is reserved for the primary one`,
          "the admin would treat a shared or secondary port as the instance's main port",
        );
      }
    }

    // R1 / R2 — declaration and code agree on whether the adapter listens
    if (listener && !entries.length) {
      report(
        listener.file,
        "opens a socket (createServer / listen / createSocket) but fleet.json declares no listenPorts",
        "the admin's port-conflict check cannot see this instance, and nothing documents which ports it takes",
        listener.line,
      );
    }
    if (!listener && entries.length) {
      report(
        FLEET,
        "declares listenPorts, but no source below src/ opens a socket",
        "a stale declaration makes the admin warn about a port nobody holds",
      );
    }

    const manifest = readJson<Dict>(adapterDir, MANIFEST);
    const native: Dict =
      isDict(manifest) && isDict(manifest.native) ? manifest.native : {};
    const settings = readJson<Dict>(adapterDir, SETTINGS);
    const primary = primaries.length === 1 ? primaries[0] : undefined;
    const listens =
      primary !== undefined || entries.some((e) => e.role === "perDevice");

    // R7 — legacy listen-address keys never reach the admin
    for (const legacy of LEGACY_BIND_KEYS) {
      if (legacy in native) {
        report(
          MANIFEST,
          `native.${legacy} carries a listen address — the admin reads native.bind only`,
          "the instance stays invisible to the port-conflict check; rename the key and migrate it on start",
        );
      }
    }

    // R4 — the primary port as the admin reads it
    if (primary) {
      const value = native[primary.key];
      if (!isPortNumber(value)) {
        report(
          MANIFEST,
          `native.${primary.key} (the primary listen port) must be a number 1..65535, not ${JSON.stringify(value)}`,
          "the admin compares numbers — a string or a missing default is never matched",
        );
      } else if (primary.fixed !== undefined && value !== primary.fixed) {
        report(
          MANIFEST,
          `native.${primary.key} is ${value}, but fleet.json fixes the port at ${primary.fixed}`,
          "the manifest advertises a port the adapter does not open",
        );
      }
      const field =
        settings === undefined ? undefined : findField(settings, primary.key);
      if (settings === undefined) {
        report(
          SETTINGS,
          "the settings form is missing, so the primary port field cannot be checked",
          "without a port field of type port the adapter's own form never warns about a conflict",
        );
      } else if (!field) {
        report(
          SETTINGS,
          `no settings field writes native.${primary.key} — the primary port needs a field of type "port" (disabled when the protocol fixes it)`,
          "the adapter's own form never warns about a second instance on the same port",
        );
      } else {
        if (field.type !== "port") {
          report(
            SETTINGS,
            `the field ${primary.key} has type "${String(field.type)}" — a listen port uses type "port"`,
            "only the port type runs the admin's conflict check",
          );
        }
        if (primary.fixed !== undefined) {
          if (!field.disabled) {
            report(
              SETTINGS,
              `the field ${primary.key} is a protocol-fixed port (${primary.fixed}) and must be disabled ("disabled": "true")`,
              "a user could change a port the protocol dictates",
            );
          }
          if (field.min !== primary.fixed || field.max !== primary.fixed) {
            report(
              SETTINGS,
              `the field ${primary.key} must pin min and max to the fixed port ${primary.fixed}`,
              "the schema allows no readOnly on port fields — min = max is the guard",
            );
          }
        } else if (!isPortNumber(field.min) || !isPortNumber(field.max)) {
          report(
            SETTINGS,
            `the field ${primary.key} needs numeric min and max`,
            "the admin's range check needs both bounds",
          );
        }
      }
    }

    // R5 / R6 — bind is the listen address, and only listeners carry it
    const bind = native.bind;
    if (listens) {
      if (typeof bind !== "string" || !bind) {
        report(
          MANIFEST,
          'native.bind (the listen address, "0.0.0.0" = all interfaces) is missing',
          "the admin's port-conflict check skips every instance without native.bind",
        );
      } else {
        const field =
          settings === undefined ? undefined : findField(settings, "bind");
        if (field) {
          if (field.type !== "ip") {
            report(
              SETTINGS,
              `the field bind has type "${String(field.type)}" — a listen address uses type "ip"`,
              "the user cannot pick an interface of this host",
            );
          }
          if (field.listenOnAllPorts !== true) {
            report(
              SETTINGS,
              "the field bind must offer 0.0.0.0 (listenOnAllPorts: true)",
              "the default listen address cannot be chosen in the form",
            );
          }
        } else if (bind !== "0.0.0.0") {
          report(
            MANIFEST,
            `native.bind is "${bind}" but the settings form has no bind field — a fixed listen address must be "0.0.0.0"`,
            "a concrete address in the manifest binds every installation to one interface of the developer's machine",
          );
        }
      }
    } else if (bind !== undefined) {
      report(
        MANIFEST,
        "native.bind is set, but fleet.json declares no primary or per-device listen port",
        "the admin would report this instance as the holder of native.port — for a client adapter that is the port of the peer",
      );
    }

    return findings;
  },
};
