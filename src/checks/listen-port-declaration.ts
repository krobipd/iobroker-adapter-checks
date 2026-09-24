import type { Check, Finding } from "../types.js";
import {
  listSourceFiles,
  readJson,
  readText,
  repoPath,
  stripTsComments,
} from "../util.js";

/** A source line that opens a listening socket: an HTTP/TCP server or a `listen()`. */
const LISTENER = /\bcreateServer\s*\(|\.listen\s*\(/;
/**
 * A datagram socket LISTENS once it is bound to a port: `socket.bind(PORT, …)`. `createSocket` alone is also every
 * sender (a discovery broadcast, bound to port 0 or not at all) — until 0.15.0 each of those counted as a listener
 * (tooling audit 2026-09-24, P9). Judged only in a file that creates a datagram socket; the first argument must not
 * be `this`/`null`/`undefined` (Function.prototype.bind) or `0` (an ephemeral port).
 */
const DGRAM_SOCKET = /\bcreateSocket\s*\(/;
const DGRAM_BIND = /\.bind\s*\(\s*(?!(?:this|null|undefined|0)\s*[,)])[^)\s]/;

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

// `disabled` is unconditional as the boolean true (the form ConfigGeneric short-circuits) or the
// string "true" (evaluated as an expression, same result); any other expression depends on the
// form data and does not fix the port.
const isUnconditionallyDisabled = (v: unknown): boolean =>
  v === true || v === "true";

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

interface Listener {
  file: string;
  line: number;
  /** The port argument as written: a number, a name, or undefined when the line shows none. */
  port?: string;
}

/** The first argument of `.bind(` / `.listen(`, or the value of `port:` in an options object. */
const PORT_ARG =
  /\.(?:bind|listen)\s*\(\s*(?:\{[^}]*?\bport\s*:\s*([A-Za-z_$][\w$]*|\d+)|([A-Za-z_$][\w$]*|\d+)\s*[,)])/;

/**
 * Every source line below `src/` that opens a socket, comments removed.
 *
 * @param adapterDir the adapter repository root
 * @returns file (repo-relative), 1-based line and the port argument of each listener
 */
function listeners(adapterDir: string): Listener[] {
  const out: Listener[] = [];
  for (const abs of listSourceFiles(adapterDir)) {
    const rel = repoPath(adapterDir, abs);
    const text = readText(adapterDir, rel);
    if (text === undefined) {
      continue;
    }
    const code = stripTsComments(text);
    const datagram = DGRAM_SOCKET.test(code);
    const lines = code.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (LISTENER.test(line) || (datagram && DGRAM_BIND.test(line))) {
        const m = PORT_ARG.exec(line);
        const port = m ? (m[1] ?? m[2]) : undefined;
        out.push({ file: rel, line: i + 1, ...(port ? { port } : {}) });
      }
    }
  }
  return out;
}

/**
 * The number a port argument stands for: a literal, or a name assigned a literal anywhere
 * below `src/` (`const SSDP_PORT = 1900`). A setting (`this.config.port`) has no number here.
 *
 * @param adapterDir the adapter repository root
 * @param arg the port argument as written
 * @returns the port number, or undefined when the code does not fix it
 */
function resolvePort(adapterDir: string, arg: string): number | undefined {
  if (/^\d+$/.test(arg)) {
    return Number(arg);
  }
  const assign = new RegExp(
    `(?:^|[^\\w$.])${arg.replace(/\$/g, "\\$")}\\s*(?::\\s*number\\s*)?=\\s*(\\d+)\\b`,
  );
  for (const abs of listSourceFiles(adapterDir)) {
    const text = readText(adapterDir, repoPath(adapterDir, abs));
    const m = text === undefined ? null : assign.exec(stripTsComments(text));
    if (m) {
      return Number(m[1]);
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
    const found = listeners(adapterDir);
    const listener = found[0];

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
        "opens a socket (createServer / listen / a datagram bind) but fleet.json declares no listenPorts",
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

    // R8 — every port the code fixes is declared (0.17.0): until then only the FIRST listener
    // was read, and a second port (SSDP 1900 beside a push port) stayed undeclared and green
    if (entries.length) {
      const declared = new Set<number>();
      for (const e of entries) {
        if (e.fixed !== undefined) {
          declared.add(e.fixed);
        }
        const value = native[e.key];
        if (isPortNumber(value)) {
          declared.add(value);
        }
      }
      for (const l of found) {
        const port =
          l.port === undefined ? undefined : resolvePort(adapterDir, l.port);
        if (port !== undefined && port !== 0 && !declared.has(port)) {
          report(
            l.file,
            `opens port ${port}, but fleet.json listenPorts declares no entry for it (as fixed, or as the manifest value of its key)`,
            "the port stays undocumented — a shared protocol port belongs in listenPorts with role shared",
            l.line,
          );
        }
      }
    }
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
          "the settings form falls back to its own limits (20..65535) and a string reaches the adapter's code as a string; the admin's port-conflict check reads native.port through parseInt — give the port as a number",
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
          if (!isUnconditionallyDisabled(field.disabled)) {
            report(
              SETTINGS,
              `the field ${primary.key} is a protocol-fixed port (${primary.fixed}) and must be disabled ("disabled": true)`,
              "a user could change a port the protocol dictates; a condition on the form data is not a fixed port",
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
