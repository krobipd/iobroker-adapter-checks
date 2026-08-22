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
  run(adapterDir: string): Finding[];
}

/** Options for {@link runChecks}. */
export interface RunOptions {
  /** Check ids to skip (an adapter may have a documented reason). */
  skip?: string[];
}
