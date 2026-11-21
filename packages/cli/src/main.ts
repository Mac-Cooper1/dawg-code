#!/usr/bin/env node
/**
 * The `dawg` command. See README.md in this package for the flags, exit codes and examples.
 */
import { main, processIo } from "./cli.ts";
import { flush } from "./io.ts";

const code = await main(process.argv.slice(2), processIo());
await flush(process.stdout);
await flush(process.stderr);
process.exit(code);
