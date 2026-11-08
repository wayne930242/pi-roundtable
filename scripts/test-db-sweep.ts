import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A bun run killed with SIGKILL cannot stop the PostgreSQL that usePostgresForTests started, so the
// server keeps running under init (parent 1) beside its data directory. This stops those servers
// and removes the stale roundtable-test-pg-* directories.

const PREFIX = "roundtable-test-pg-";
const STALE_AFTER_MS = 10 * 60 * 1000;

/** The server pid in a data directory's postmaster.pid, whose first line it is. */
export function postmasterPid(contents: string): number | undefined {
	const pid = Number(contents.split("\n")[0]);
	return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

/** True when `pid` is a postgres process whose starting run is gone, so init adopted it. */
function orphaned(pid: number): boolean {
	const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "ppid=,comm="]);
	const match = /^\s*(\d+)\s+(.*)$/.exec(ps.stdout.toString().trim());
	return match?.[1] === "1" && /postgres/.test(match[2] ?? "");
}

if (import.meta.main) {
	const root = tmpdir();
	for (const name of readdirSync(root)) {
		if (!name.startsWith(PREFIX)) continue;
		const dir = join(root, name);
		const file = join(dir, "data", "postmaster.pid");
		const pid = existsSync(file)
			? postmasterPid(readFileSync(file, "utf8"))
			: undefined;
		if (pid && orphaned(pid)) {
			process.kill(pid, "SIGINT");
			console.log(`stopped orphaned test PostgreSQL ${pid}`);
			await Bun.sleep(1000);
		} else if (pid) continue;
		// A fresh directory may belong to a run that is still starting its server.
		if (Date.now() - statSync(dir).mtimeMs < STALE_AFTER_MS) continue;
		rmSync(dir, { recursive: true, force: true });
		console.log(`removed ${dir}`);
	}
}
