#!/usr/bin/env node

import { launchFerrite } from "../lib/cli-package.js";

try {
  const result = launchFerrite(process.argv.slice(2));
  if (result.signal) {
    process.kill(process.pid, result.signal);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
