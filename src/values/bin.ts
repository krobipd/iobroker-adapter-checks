#!/usr/bin/env node
import { runUnits, runValues, UNITS_USAGE, USAGE } from "./cli.js";

const [command, ...rest] = process.argv.slice(2);
if (command === "values") {
  process.exitCode = runValues(rest);
} else if (command === "units") {
  process.exitCode = runUnits(rest);
} else {
  console.log(`${USAGE}\n${UNITS_USAGE}`);
  process.exitCode = 2;
}
