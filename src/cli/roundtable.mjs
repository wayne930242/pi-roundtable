#!/usr/bin/env node
// The bin npm links. It runs under Node only to find Bun: with Bun it hands over, without it
// it says where to get it, since a `bun` shebang would fail with an error nobody can read.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("./main.ts", import.meta.url));

if (typeof Bun !== "undefined") {
	await import("./main.ts");
} else {
	const run = spawnSync("bun", [main, ...process.argv.slice(2)], {
		stdio: "inherit",
	});
	if (run.error?.code === "ENOENT") {
		console.error(
			"Bun is not installed. pi-roundtable runs on Bun: install it from https://bun.sh/docs/installation and run this command again.",
		);
		process.exit(1);
	}
	process.exit(run.status ?? 1);
}
