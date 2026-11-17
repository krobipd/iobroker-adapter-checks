import { afterEach, describe, expect, it, vi } from "vitest";

describe("bin", () => {
  const argv = process.argv;

  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    vi.doUnmock("./cli.js");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  /**
   * Load the program entry with the given command line, the commands replaced by stand-ins.
   *
   * @param args the arguments after the program name
   * @returns the stand-ins and the exit code the entry set
   */
  const start = async (
    args: string[],
  ): Promise<{
    runValues: ReturnType<typeof vi.fn>;
    runUnits: ReturnType<typeof vi.fn>;
    printed: unknown[][];
    code: unknown;
  }> => {
    const runValues = vi.fn((_args: string[]) => 0);
    const runUnits = vi.fn((_args: string[]) => 0);
    vi.doMock("./cli.js", () => ({
      runValues,
      runUnits,
      USAGE: "usage",
      UNITS_USAGE: "units usage",
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.argv = ["node", "bin.js", ...args];
    await import("./bin.js");
    return {
      runValues,
      runUnits,
      printed: log.mock.calls,
      code: process.exitCode,
    };
  };

  it("hands `values` and its arguments to the values command", async () => {
    const { runValues, runUnits, code } = await start([
      "values",
      "--objects",
      "x.json",
    ]);
    expect(runValues).toHaveBeenCalledWith(["--objects", "x.json"]);
    expect(runUnits).not.toHaveBeenCalled();
    expect(code).toBe(0);
  });

  it("hands `units` and its unit texts to the units command", async () => {
    const { runValues, runUnits, code } = await start(["units", "kW", "m"]);
    expect(runUnits).toHaveBeenCalledWith(["kW", "m"]);
    expect(runValues).not.toHaveBeenCalled();
    expect(code).toBe(0);
  });

  it("prints the usage of both commands and ends with 2 for anything else", async () => {
    const { runValues, runUnits, printed, code } = await start(["judge"]);
    expect(runValues).not.toHaveBeenCalled();
    expect(runUnits).not.toHaveBeenCalled();
    expect(printed).toEqual([["usage\nunits usage"]]);
    expect(code).toBe(2);
  });
});
