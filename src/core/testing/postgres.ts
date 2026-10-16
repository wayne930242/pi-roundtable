import { afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { adoptTestDatabase } from "./database.ts";

export interface UsePostgresOptions {
	/** Directories searched for initdb and postgres before PATH; default PG_BIN and the usual Homebrew and Debian paths. */
	binDirs?: readonly string[];
	/** Throw when initdb or postgres is not found; default false (the tests that need it skip or call requireDatabase). */
	require?: boolean;
}

/** Where a PostgreSQL install usually keeps initdb and postgres, newest first. */
const USUAL_DIRS = [
	...[17, 16, 15, 14].map(
		(major) => `/opt/homebrew/opt/postgresql@${major}/bin`,
	),
	...[17, 16, 15, 14].map((major) => `/usr/lib/postgresql/${major}/bin`),
	"/usr/local/bin",
	"/usr/bin",
];

const READY_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;

function binary(name: string, dirs: readonly string[]): string | undefined {
	for (const dir of dirs) {
		const path = join(dir, name);
		if (existsSync(path)) return path;
	}
	return Bun.which(name) ?? undefined;
}

/** A TCP port nothing listens on, found by binding port 0 and letting it go. */
async function freePort(): Promise<number> {
	const probe = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(),
	});
	const port = probe.port ?? 0;
	await probe.stop(true);
	return port;
}

/** Waits until the server at `url` answers a query, or throws when it exited or the wait ran out. */
async function untilReady(url: string, server: Bun.Subprocess): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	for (;;) {
		if (server.exitCode !== null)
			throw new Error(
				`the test PostgreSQL exited with code ${server.exitCode} before it was ready`,
			);
		const sql = new SQL(url, { max: 1 });
		try {
			await sql`SELECT 1`;
			await sql.close();
			return;
		} catch {
			await sql.close().catch(() => undefined);
			if (Date.now() > deadline)
				throw new Error(
					`the test PostgreSQL did not become ready in ${READY_TIMEOUT_MS / 1000} seconds`,
				);
			await Bun.sleep(100);
		}
	}
}

/**
 * For a test preload: unless ROUNDTABLE_TEST_DATABASE_URL is set, starts a throwaway PostgreSQL on
 * 127.0.0.1 (trust auth, fsync off, a temporary data directory), sets the variable and
 * `testDatabaseUrl`, and stops and removes it after the run (bun's global afterAll, exit and signals).
 */
export async function usePostgresForTests(
	options: UsePostgresOptions = {},
): Promise<void> {
	const given = process.env.ROUNDTABLE_TEST_DATABASE_URL;
	if (given) {
		adoptTestDatabase(given);
		return;
	}
	const dirs = options.binDirs ?? [process.env.PG_BIN ?? "", ...USUAL_DIRS];
	const initdb = binary("initdb", dirs.filter(Boolean));
	const postgres = binary("postgres", dirs.filter(Boolean));
	if (!initdb || !postgres) {
		if (options.require)
			throw new Error(
				"this run needs PostgreSQL: install it so initdb and postgres are on PATH, set PG_BIN to its bin directory, or set ROUNDTABLE_TEST_DATABASE_URL to a throwaway database",
			);
		return;
	}
	const root = mkdtempSync(join(tmpdir(), "roundtable-test-pg-"));
	const data = join(root, "data");
	const init = spawnSync(
		initdb,
		["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-sync"],
		{ encoding: "utf8" },
	);
	if (init.status !== 0) {
		rmSync(root, { recursive: true, force: true });
		throw new Error(`initdb failed: ${init.stderr}`);
	}
	const port = await freePort();
	const server = Bun.spawn(
		[
			postgres,
			"-D",
			data,
			"-p",
			String(port),
			"-k",
			root,
			"-c",
			"listen_addresses=127.0.0.1",
			"-c",
			"fsync=off",
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		// SIGINT is PostgreSQL's fast shutdown: sessions end and the server exits at once.
		server.kill("SIGINT");
		await Promise.race([server.exited, Bun.sleep(STOP_TIMEOUT_MS)]);
		rmSync(root, { recursive: true, force: true });
	};
	// A global hook of the run: bun runs preload hooks once, after every test file.
	afterAll(stop);
	process.on("exit", () => {
		if (stopped) return;
		server.kill("SIGINT");
		// A process that exits without the run's hooks leaves no data directory behind. The server
		// writes while it shuts down, so removing it takes a few tries.
		for (let attempt = 0; attempt < 100 && existsSync(root); attempt++) {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
			}
		}
	});
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.on(signal, () => {
			void stop().then(() => process.exit(1));
		});
	const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
	try {
		await untilReady(url, server);
	} catch (error) {
		await stop();
		throw error;
	}
	adoptTestDatabase(url);
}
