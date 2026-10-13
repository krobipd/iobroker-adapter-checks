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
   * Load the program entry with the given command line, the values command replaced by a stand-in.
   *
   * @param args the arguments after the program name
   * @returns the stand-in and the exit code the entry set
   */
  const start = async (
    args: string[],
  ): Promise<{ runValues: ReturnType<typeof vi.fn>; code: unknown }> => {
    const runValues = vi.fn((_args: string[]) => 0);
    vi.doMock("./cli.js", () => ({ runValues, USAGE: "usage" }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.argv = ["node", "bin.js", ...args];
    await import("./bin.js");
    return { runValues, code: process.exitCode };
  };

  it("hands `values` and its arguments to the values command", async () => {
    const { runValues, code } = await start(["values", "--objects", "x.json"]);
    expect(runValues).toHaveBeenCalledWith(["--objects", "x.json"]);
    expect(code).toBe(0);
  });

  it("prints the usage and ends with 2 for anything else", async () => {
    const { runValues, code } = await start(["judge"]);
    expect(runValues).not.toHaveBeenCalled();
    expect(code).toBe(2);
  });
});
