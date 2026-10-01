#!/usr/bin/env bun
import { processEnvironment, runCli } from "./cli.ts";

// pi-lens-ignore: no-unknown-parameters
runCli(process.argv.slice(2), processEnvironment()).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		// A boot that failed has stopped what it started; nothing may keep the process up.
		process.exit(1);
	},
);
