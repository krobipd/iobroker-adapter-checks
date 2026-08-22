/** One problem found by a check. */
export interface Finding {
  /** Check that produced this finding, e.g. "switch-default". */
  check: string;
  /** Repo-relative file the finding sits in, e.g. "src/main.ts". */
  file: string;
  /** 1-based line, when the check can point at one. */
  line?: number;
  /** What is wrong, in one sentence — this is what a developer reads first. */
  message: string;
  /** What it costs at runtime / why it matters. Optional, one sentence. */
  impact?: string;
}

/** A single check: reads files below `adapterDir`, never writes, never uses the network. */
export interface Check {
  /** Stable id, used in the finding and to skip a check. */
  id: string;
  /** One line for humans, shown in the test name. */
  title: string;
  /**
   * Inspect one adapter repository.
   *
   * @param adapterDir the adapter repository root (where package.json sits)
   * @param options settings a check may honour; every check works without them
   * @returns everything wrong this check knows about; empty means clean
   */
  run(adapterDir: string, options?: CheckOptions): Finding[];
}

/** Settings individual checks read. */
export interface CheckOptions {
  /**
   * Longest allowed line in a release note, in characters.
   *
   * Off unless set: ioBroker itself has no such limit — the repository checker counts
   * entries, not characters. Teams that keep release notes short (200 is a common
   * choice) can switch it on; a package must not impose it.
   */
  maxChangelogLineLength?: number;
}

/** Options for {@link runChecks}. */
export interface RunOptions extends CheckOptions {
  /** Check ids to skip (an adapter may have a documented reason). */
  skip?: string[];
}
