import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceIdSchemeCheck } from "./device-id-scheme.js";

describe("device-id-scheme", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "checks-device-id-"));
    mkdirSync(join(dir, "test"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const inventory = (objects: Record<string, unknown>): void =>
    writeFileSync(
      join(dir, "test", "objects.inventory.json"),
      JSON.stringify(objects),
    );
  const fleet = (body: unknown): void =>
    writeFileSync(join(dir, "fleet.json"), JSON.stringify(body));
  const device = (idScheme?: unknown): Record<string, unknown> => ({
    type: "device",
    common: { name: "x" },
    native: idScheme === undefined ? {} : { idScheme },
  });

  it("passes devices on the scheme, nested or at the root", () => {
    inventory({
      "demo.0.h61be-525f": device(3),
      "demo.0.devices.rx-a2a-e7d3": device(3),
      "demo.0.devices.r-n500": device(3),
      "demo.0.devices.rx-v473-2": device(3),
      "demo.0.info": { type: "channel", common: {}, native: {} },
    });
    fleet({ deviceIds: "unit" });
    expect(deviceIdSchemeCheck.run(dir)).toEqual([]);
  });

  it("stays silent without an inventory or without devices", () => {
    expect(deviceIdSchemeCheck.run(dir)).toEqual([]);
    inventory({ "demo.0.info": { type: "channel", common: {}, native: {} } });
    expect(deviceIdSchemeCheck.run(dir)).toEqual([]);
  });

  it("reports devices without a declaration — leaving it out does not take an adapter out of the rule", () => {
    inventory({ "demo.0.hwe-p1_5c2faf000011": device() });
    const findings = deviceIdSchemeCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("fleet.json");
    fleet({ listenPorts: [] });
    expect(deviceIdSchemeCheck.run(dir)[0]?.message).toContain(
      "does not say where their ids come from",
    );
  });

  it("reports a unit device without the scheme mark or with another id form", () => {
    inventory({
      "demo.0.hwe-p1_5c2faf000011": device(),
      "demo.0.h61be_525f": device(3),
      "demo.0.H61BE-525F": device(3),
      "demo.0.old": device(2),
    });
    fleet({ deviceIds: "unit" });
    const messages = deviceIdSchemeCheck.run(dir).map((f) => f.message);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toContain("no native.idScheme 3");
    expect(messages[1]).toContain('"h61be_525f"');
    expect(messages[2]).toContain('"H61BE-525F"');
    expect(messages[3]).toContain("no native.idScheme 3");
  });

  it("accepts a user-named tree with its source and nothing else", () => {
    inventory({ "demo.0.systems.backup_nas": device() });
    fleet({
      deviceIds: { userNamed: "the system name set in the Beszel hub" },
    });
    expect(deviceIdSchemeCheck.run(dir)).toEqual([]);
  });

  it("reports a declaration that names no source or is something else", () => {
    inventory({ "demo.0.tv": device() });
    for (const bad of [
      { userNamed: "hub" },
      { userNamed: "" },
      { userNamed: 3 },
      { other: "x" },
      { userNamed: "the hub name", extra: 1 },
      "units",
      3,
      null,
    ]) {
      fleet({ deviceIds: bad });
      const findings = deviceIdSchemeCheck.run(dir);
      expect(findings, JSON.stringify(bad)).toHaveLength(1);
      expect(findings[0]?.file, JSON.stringify(bad)).toBe("fleet.json");
    }
  });

  it("skips objects that are no dictionaries", () => {
    inventory({ "demo.0.x": "device", "demo.0.y": device(3) });
    writeFileSync(
      join(dir, "test", "objects.inventory.json"),
      JSON.stringify({
        "demo.0.x": "device",
        "demo.0.dev-0001": {
          type: "device",
          common: {},
          native: { idScheme: 3 },
        },
      }),
    );
    fleet({ deviceIds: "unit" });
    expect(deviceIdSchemeCheck.run(dir)).toEqual([]);
  });

  it("treats a device without native as unmarked", () => {
    writeFileSync(
      join(dir, "test", "objects.inventory.json"),
      JSON.stringify({ "demo.0.a-0001": { type: "device" } }),
    );
    fleet({ deviceIds: "unit" });
    expect(deviceIdSchemeCheck.run(dir)[0]?.message).toContain(
      "no native.idScheme 3",
    );
  });

  it("ignores an inventory that is no object", () => {
    writeFileSync(join(dir, "test", "objects.inventory.json"), "[]");
    expect(deviceIdSchemeCheck.run(dir)).toEqual([]);
  });
});
