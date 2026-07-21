#!/usr/bin/env node
import { assertBuildClientImportContract } from "./build-client-import-guard.mjs";

await assertBuildClientImportContract(process.argv.slice(2));
await import("./build-client-base.mjs");
