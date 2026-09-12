import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messageboxRepairCheck } from "./messagebox-repair.js";

describe("messagebox-repair", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "messagebox-repair-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** One main.ts; the manifest is written only when `supported` is given ("absent" = no file). */
  const adapter = (
    mainTs: string,
    supported: unknown = "absent",
    options: { withSrc?: boolean } = {},
  ): void => {
    if (options.withSrc ?? true) {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "main.ts"), mainTs);
    }
    if (supported !== "absent") {
      const common: Record<string, unknown> = { name: "x" };
      if (supported !== null) {
        common.supportedMessages = supported;
      }
      writeFileSync(join(dir, "io-package.json"), JSON.stringify({ common }));
    }
  };

  const GOOD = `
      const supported = obj?.common?.supportedMessages;
      if (supported === undefined || supported === null) {
        return false;
      }
      await this.extendForeignObjectAsync(id, { common: { supportedMessages: null } });
    `;

  const messages = (): string[] =>
    messageboxRepairCheck.run(dir).map((f) => f.message);

  it("accepts the correct implementation", () => {
    adapter(GOOD);
    expect(messageboxRepairCheck.run(dir)).toEqual([]);
  });

  it("reports writing an object, with the line", () => {
    adapter(
      GOOD.replace(
        "supportedMessages: null",
        "supportedMessages: { stopInstance: false }",
      ),
    );
    const findings = messageboxRepairCheck.run(dir);
    const hit = findings.find((f) => f.message.includes("writes an object"));
    expect(hit?.file).toBe("src/main.ts");
    expect(hit?.line).toBe(6);
  });

  it("reports a guard on stopInstance", () => {
    adapter(
      GOOD.replace(
        "if (supported === undefined || supported === null) {",
        "if (!supported?.stopInstance) {",
      ),
    );
    expect(
      messages().some((m) => m.includes("triggered by `stopInstance`")),
    ).toBe(true);
  });

  it("still reports the guard when it hides behind a cast", () => {
    // A regex on `supported?.stopInstance` let the cast form through — measured.
    adapter(
      GOOD.replace(
        "if (supported === undefined || supported === null) {",
        "if (!(supported as { stopInstance?: unknown } | undefined)?.stopInstance) {",
      ),
    );
    expect(
      messages().some((m) => m.includes("triggered by `stopInstance`")),
    ).toBe(true);
  });

  it("is not triggered by comments", () => {
    // A check that reports its own explanation gets switched off instead of read.
    adapter(
      GOOD +
        `
      // The earlier guard (\`if (!supported?.stopInstance)\`) never matched its own
      // result, and writing { supportedMessages: { stopInstance: false } } shut the box.
      /* supportedMessages: { stopInstance: false } — do not do this */
    `,
    );
    expect(messageboxRepairCheck.run(dir)).toEqual([]);
  });

  it("accepts an adapter that never touches the field", () => {
    adapter("const x = 1;");
    expect(messageboxRepairCheck.run(dir)).toEqual([]);
  });

  it("accepts a missing src/", () => {
    adapter("", "absent", { withSrc: false });
    expect(messageboxRepairCheck.run(dir)).toEqual([]);
  });

  // --- Regime B: the adapter NEEDS the key (deviceManager) ---------------------------
  // A first version knew one regime only and told a device-manager adapter to delete the
  // key — which would have switched its device manager off.

  const DEVICE_MANAGER = { deviceManager: true };

  it("accepts a device-manager adapter that merges the flag", () => {
    adapter(
      GOOD.replace(
        "supportedMessages: null",
        "supportedMessages: { stopInstance: false }",
      ).replace(
        "if (supported === undefined || supported === null) {",
        "if (!supported?.stopInstance) {",
      ),
      DEVICE_MANAGER,
    );
    expect(messageboxRepairCheck.run(dir)).toEqual([]);
  });

  it("reports a device-manager adapter that deletes the key", () => {
    adapter(GOOD, DEVICE_MANAGER);
    const findings = messageboxRepairCheck.run(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("deletes common.supportedMessages");
    expect(findings[0]?.message).toContain("deviceManager");
    expect(findings[0]?.line).toBe(6);
  });

  it("keeps a manifest with only false entries in regime A", () => {
    // Nothing but false values is no positive list — the box would be off. The normal
    // case applies, writing an object stays a finding.
    adapter(
      GOOD.replace(
        "supportedMessages: null",
        "supportedMessages: { stopInstance: false }",
      ),
      { stopInstance: false },
    );
    expect(messages().some((m) => m.includes("writes an object"))).toBe(true);
  });

  // --- Foreign adapters: only a repair is judged -------------------------------------

  it("leaves an adapter alone that only reads the field and handles the message", () => {
    adapter(
      `
      const supported = obj?.common?.supportedMessages;
      this.log.debug(\`supportedMessages: \${JSON.stringify(supported)}\`);
      if (obj.command === "stopInstance") {
        await this.shutdownGracefully();
      }
    `,
    );
    expect(messageboxRepairCheck.run(dir)).toEqual([]);
  });

  it("reports every occurrence with its own line", () => {
    adapter(
      GOOD.replace(
        "if (supported === undefined || supported === null) {",
        "if (!supported?.stopInstance) {",
      ) + "\nif (again?.stopInstance) { }\n",
    );
    const lines = messageboxRepairCheck
      .run(dir)
      .filter((f) => f.message.includes("triggered by"))
      .map((f) => f.line);
    expect(lines).toEqual([3, 8]);
  });
});
