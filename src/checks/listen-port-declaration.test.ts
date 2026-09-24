import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listenPortDeclarationCheck } from "./listen-port-declaration.js";

describe("listen-port-declaration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "listen-port-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fleet = (listenPorts?: unknown): void => {
    const body: Record<string, unknown> = {
      manifestI18n: {},
      forumThread: null,
    };
    if (listenPorts !== undefined) {
      body.listenPorts = listenPorts;
    }
    writeFileSync(join(dir, "fleet.json"), JSON.stringify(body));
  };
  const manifest = (native: unknown): void => {
    writeFileSync(
      join(dir, "io-package.json"),
      JSON.stringify({ common: { name: "demo" }, native }),
    );
  };
  const settings = (items: unknown): void => {
    mkdirSync(join(dir, "admin"), { recursive: true });
    writeFileSync(
      join(dir, "admin", "jsonConfig.json"),
      JSON.stringify({
        type: "tabs",
        items: { tabMain: { type: "panel", items } },
      }),
    );
  };
  const source = (text: string, file = "main.ts"): void => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", file), text);
  };
  const run = (): string[] =>
    listenPortDeclarationCheck.run(dir).map((f) => `${f.file}: ${f.message}`);

  const tcpServer = "const s = createServer();\ns.listen({ port: 8080 });\n";
  const portField = (extra: Record<string, unknown> = {}): unknown => ({
    type: "port",
    min: 1,
    max: 65535,
    ...extra,
  });
  const bindField = { type: "ip", listenOnAllPorts: true, onlyIp4: true };

  // --- clients ---------------------------------------------------------------------------

  it("says nothing for a client adapter: no socket, no declaration, no bind", () => {
    fleet();
    manifest({ host: "ups.local", port: 3493, networkInterface: "0.0.0.0" });
    settings({ port: { type: "number", min: 1, max: 65535 } });
    source("import net from 'node:net';\nnet.connect(3493, 'ups.local');\n");
    expect(run()).toEqual([]);
  });

  it("says nothing without any source or manifest at all", () => {
    expect(run()).toEqual([]);
  });

  it("reports native.bind on an adapter that declares no listener", () => {
    fleet();
    manifest({ host: "ups.local", port: 3493, bind: "0.0.0.0" });
    const findings = run();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("native.bind is set");
  });

  // --- R1 / R2 ---------------------------------------------------------------------------

  it("reports a socket without a declaration, pointing at the line", () => {
    source(tcpServer);
    manifest({ port: 8080 });
    const findings = listenPortDeclarationCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("src/main.ts");
    expect(findings[0].line).toBe(1);
    expect(findings[0].message).toContain("declares no listenPorts");
  });

  it("does not count a listen() that only lives in a comment", () => {
    source(
      "// legacy: server.listen(8080)\n/* createServer() */\nexport const x = 1;\n",
    );
    manifest({});
    expect(run()).toEqual([]);
  });

  it("finds the socket in a nested file, not only in main.ts", () => {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(join(dir, "src", "main.ts"), "export const x = 1;\n");
    writeFileSync(
      join(dir, "src", "lib", "udp.ts"),
      "import dgram from 'node:dgram';\nexport const s = dgram.createSocket('udp4');\ns.bind(41100);\n",
    );
    manifest({});
    const findings = listenPortDeclarationCheck.run(dir);
    expect(findings.map((f) => f.file)).toEqual(["src/lib/udp.ts"]);
  });

  it("a datagram sender is no listener — bound to port 0, or not at all, and Function.bind is no bind (0.15.0)", () => {
    // tooling audit 2026-09-24 (P9)
    source(
      "import dgram from 'node:dgram';\nconst a = dgram.createSocket('udp4');\na.send(b, 1900, host);\n" +
        "const b = dgram.createSocket('udp4');\nb.bind(0, addr, () => {});\nthis.on('ready', this.onReady.bind(this));\n",
    );
    manifest({});
    expect(listenPortDeclarationCheck.run(dir)).toEqual([]);
  });

  it("reports a declaration nothing in src/ backs", () => {
    fleet([{ key: "port", protocol: "tcp", role: "primary" }]);
    manifest({ port: 8080, bind: "0.0.0.0" });
    settings({ port: portField(), bind: bindField });
    source("export const x = 1;\n");
    expect(run()).toEqual([
      "fleet.json: declares listenPorts, but no source below src/ opens a socket",
    ]);
  });

  // --- R3 shape ---------------------------------------------------------------------------

  it("reports a declaration that is not a list", () => {
    fleet({ key: "port" });
    source(tcpServer);
    manifest({ port: 8080, bind: "0.0.0.0" });
    const findings = run();
    expect(findings[0]).toContain("not a list");
  });

  it("reports every malformed entry with its index", () => {
    fleet([
      "port",
      { protocol: "tcp", role: "primary" },
      { key: "a", protocol: "http", role: "primary" },
      { key: "b", protocol: "tcp", role: "main" },
      { key: "c", protocol: "udp", role: "shared", fixed: "1900" },
      { key: "d", protocol: "udp", role: "shared", fixed: 70000, port: 1 },
    ]);
    source(tcpServer);
    manifest({});
    const text = run().join("\n");
    expect(text).toContain("listenPorts[0] is not an object");
    expect(text).toContain("listenPorts[1].key is missing");
    expect(text).toContain("listenPorts[2].protocol");
    expect(text).toContain("listenPorts[3].role");
    expect(text).toContain("listenPorts[4].fixed");
    expect(text).toContain("listenPorts[5].fixed");
    expect(text).toContain("listenPorts[5] carries unknown keys: port");
  });

  it("allows comment keys inside an entry", () => {
    fleet([
      { _why: "the bridge", key: "port", protocol: "tcp", role: "primary" },
    ]);
    source(tcpServer);
    manifest({ port: 8080, bind: "0.0.0.0" });
    settings({ port: portField(), bind: bindField });
    expect(run()).toEqual([]);
  });

  it("reports two primaries, a duplicate key, a secondary without primary and a shared 'port'", () => {
    fleet([
      { key: "port", protocol: "tcp", role: "shared" },
      { key: "httpsPort", protocol: "tcp", role: "secondary" },
      { key: "httpsPort", protocol: "udp", role: "shared" },
    ]);
    source(tcpServer);
    manifest({});
    const text = run().join("\n");
    expect(text).toContain('names the key "httpsPort" twice');
    expect(text).toContain("secondary port but no primary");
    expect(text).toContain('uses the key "port" for a shared port');

    fleet([
      { key: "a", protocol: "tcp", role: "primary" },
      { key: "b", protocol: "tcp", role: "primary" },
    ]);
    expect(run().join("\n")).toContain("declares 2 primary ports");
  });

  // --- R4 the primary port -----------------------------------------------------------------

  it("accepts a configurable tcp port stored as a number with a port field and an ip bind field", () => {
    fleet([
      { key: "port", protocol: "tcp", role: "primary" },
      { key: "httpsPort", protocol: "tcp", role: "secondary" },
      { key: "upnpPort", protocol: "udp", role: "shared", fixed: 1900 },
    ]);
    source(tcpServer);
    manifest({ port: 8080, bind: "0.0.0.0", httpsPort: "", upnpPort: "1900" });
    settings({
      port: portField(),
      bind: bindField,
      httpsPort: { type: "text" },
    });
    expect(run()).toEqual([]);
  });

  it("reports the primary port stored as a string", () => {
    fleet([{ key: "port", protocol: "tcp", role: "primary" }]);
    source(tcpServer);
    manifest({ port: "8080", bind: "0.0.0.0" });
    settings({ port: portField(), bind: bindField });
    expect(run()).toEqual([
      'io-package.json: native.port (the primary listen port) must be a number 1..65535, not "8080"',
    ]);
  });

  it("reports a port field that is not of type port, and a missing field", () => {
    fleet([{ key: "port", protocol: "tcp", role: "primary" }]);
    source(tcpServer);
    manifest({ port: 8080, bind: "0.0.0.0" });
    settings({ port: { type: "number", min: 1, max: 65535 }, bind: bindField });
    expect(run()).toEqual([
      'admin/jsonConfig.json: the field port has type "number" — a listen port uses type "port"',
    ]);
    settings({ bind: bindField });
    expect(run().join("\n")).toContain("no settings field writes native.port");
  });

  it("reports a missing settings form when a primary port is declared", () => {
    fleet([{ key: "port", protocol: "tcp", role: "primary" }]);
    source(tcpServer);
    manifest({ port: 8080, bind: "0.0.0.0" });
    const text = run().join("\n");
    expect(text).toContain("the settings form is missing");
  });

  it("reports a configurable port field without min/max", () => {
    fleet([{ key: "port", protocol: "tcp", role: "primary" }]);
    source(tcpServer);
    manifest({ port: 8080, bind: "0.0.0.0" });
    settings({ port: { type: "port" }, bind: bindField });
    expect(run()).toEqual([
      "admin/jsonConfig.json: the field port needs numeric min and max",
    ]);
  });

  it("holds a protocol-fixed port to the manifest and to a disabled, pinned field", () => {
    const declare = (): void =>
      fleet([{ key: "port", protocol: "tcp", role: "primary", fixed: 8123 }]);
    declare();
    source(tcpServer);
    manifest({ port: 8123, bind: "0.0.0.0" });
    settings({
      port: { type: "port", disabled: "true", min: 8123, max: 8123 },
      bind: bindField,
    });
    expect(run()).toEqual([]);

    manifest({ port: 8124, bind: "0.0.0.0" });
    expect(run()).toEqual([
      "io-package.json: native.port is 8124, but fleet.json fixes the port at 8123",
    ]);

    manifest({ port: 8123, bind: "0.0.0.0" });
    settings({ port: { type: "port", min: 8123, max: 8123 }, bind: bindField });
    expect(run().join("\n")).toContain("must be disabled");

    // boolean true is the form ConfigGeneric short-circuits; the string "true" evaluates the same
    settings({
      port: { type: "port", disabled: true, min: 8123, max: 8123 },
      bind: bindField,
    });
    expect(run()).toEqual([]);

    // a condition on the form data is not a fixed port
    settings({
      port: { type: "port", disabled: "!data.enabled", min: 8123, max: 8123 },
      bind: bindField,
    });
    expect(run().join("\n")).toContain("must be disabled");

    settings({
      port: { type: "port", disabled: "true", min: 1, max: 65535 },
      bind: bindField,
    });
    expect(run().join("\n")).toContain(
      "must pin min and max to the fixed port 8123",
    );
  });

  // --- R5 bind ----------------------------------------------------------------------------

  it("reports a listener without native.bind", () => {
    fleet([{ key: "port", protocol: "tcp", role: "primary" }]);
    source(tcpServer);
    manifest({ port: 8080, host: "0.0.0.0" });
    settings({ port: portField(), host: bindField });
    expect(run()).toEqual([
      'io-package.json: native.bind (the listen address, "0.0.0.0" = all interfaces) is missing',
    ]);
  });

  it("reports a bind field that is not an ip field offering all interfaces", () => {
    fleet([{ key: "port", protocol: "tcp", role: "primary" }]);
    source(tcpServer);
    manifest({ port: 8080, bind: "0.0.0.0" });
    settings({ port: portField(), bind: { type: "text" } });
    const text = run().join("\n");
    expect(text).toContain('the field bind has type "text"');
    expect(text).toContain("listenOnAllPorts: true");
  });

  it("accepts a fixed 0.0.0.0 bind without a field, but not a concrete address", () => {
    fleet([{ key: "port", protocol: "udp", role: "primary", fixed: 41100 }]);
    source(
      "import { createSocket } from 'node:dgram';\nexport const s = createSocket('udp4');\ns.bind(41100);\n",
    );
    manifest({ port: 41100, bind: "0.0.0.0", networkInterface: "0.0.0.0" });
    settings({
      port: { type: "port", disabled: "true", min: 41100, max: 41100 },
      networkInterface: bindField,
    });
    expect(run()).toEqual([]);
    manifest({ port: 41100, bind: "10.0.0.5", networkInterface: "0.0.0.0" });
    expect(run().join("\n")).toContain('native.bind is "10.0.0.5"');
  });

  it("requires bind for per-device ports and needs no native.port there", () => {
    fleet([
      { key: "devices[].port", protocol: "tcp", role: "perDevice" },
      { key: "ssdp", protocol: "udp", role: "shared", fixed: 1900 },
    ]);
    source(
      "import http from 'node:http';\nhttp.createServer().listen(8060);\n",
    );
    manifest({ bind: "0.0.0.0", devices: [] });
    settings({ bind: bindField });
    expect(run()).toEqual([]);
    manifest({ networkInterface: "0.0.0.0", devices: [] });
    settings({ networkInterface: bindField });
    expect(run()).toEqual([
      'io-package.json: native.bind (the listen address, "0.0.0.0" = all interfaces) is missing',
    ]);
  });

  // --- R7 legacy keys -----------------------------------------------------------------------

  it("reports the legacy listen-address keys", () => {
    fleet([{ key: "port", protocol: "tcp", role: "primary" }]);
    source(tcpServer);
    manifest({ port: 8080, bind: "0.0.0.0", bindAddress: "0.0.0.0", BIND: "" });
    settings({ port: portField(), bind: bindField });
    const text = run().join("\n");
    expect(text).toContain("native.bindAddress carries a listen address");
    expect(text).toContain("native.BIND carries a listen address");
  });

  it("finds the port field inside nested panels", () => {
    fleet([{ key: "port", protocol: "tcp", role: "primary" }]);
    source(tcpServer);
    manifest({ port: 8080, bind: "0.0.0.0" });
    mkdirSync(join(dir, "admin"), { recursive: true });
    writeFileSync(
      join(dir, "admin", "jsonConfig.json"),
      JSON.stringify({
        type: "tabs",
        items: {
          tab1: {
            type: "panel",
            items: {
              group: {
                type: "panel",
                items: { port: portField(), bind: bindField },
              },
              table: {
                type: "table",
                items: [{ attr: "port", type: "number" }],
              },
            },
          },
        },
      }),
    );
    expect(run()).toEqual([]);
  });
});
