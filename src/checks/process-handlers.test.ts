import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processHandlersCheck } from "./process-handlers.js";

describe("process-handlers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "process-handlers-"));
    mkdirSync(join(dir, "src"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const source = (text: string, name = "main.ts"): string[] => {
    writeFileSync(join(dir, "src", name), text);
    return processHandlersCheck.run(dir).map((f) => f.message);
  };

  it("reports a process-wide unhandledRejection handler", () => {
    expect(
      source(`process.on("unhandledRejection", (e) => log(e));\n`),
    ).toHaveLength(1);
  });

  it("reports uncaughtException registered with once and addListener", () => {
    const text = `process.once('uncaughtException', f);\nprocess.addListener("uncaughtException", g);\n`;
    expect(source(text)).toHaveLength(2);
  });

  it("points at the line", () => {
    writeFileSync(
      join(dir, "src", "main.ts"),
      `const a = 1;\n\nprocess.on("uncaughtException", f);\n`,
    );
    expect(processHandlersCheck.run(dir)[0]?.line).toBe(3);
  });

  it("accepts other process events and commented-out code", () => {
    const text = `process.on("SIGTERM", stop);\n// process.on("unhandledRejection", f);\n`;
    expect(source(text)).toEqual([]);
  });

  it("leaves tests alone", () => {
    expect(
      source(`process.on("unhandledRejection", f);\n`, "main.test.ts"),
    ).toEqual([]);
  });
});
