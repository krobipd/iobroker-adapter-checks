#!/usr/bin/env node
import { runValues, USAGE } from "./cli.js";

const [command, ...rest] = process.argv.slice(2);
if (command === "values") {
  process.exitCode = runValues(rest);
} else {
  console.log(USAGE);
  process.exitCode = 2;
}
