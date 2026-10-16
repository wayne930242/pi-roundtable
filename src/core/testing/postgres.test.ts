import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `usePostgresForTests` is a preload of `bun test`, and it reads the process environment, so each
// case runs a small `bun test` of its own over a preload and a test file written to a temp dir.

const ENTRY = join(import.meta.dir, "..", "..", "testing.ts");
const root = mkdtempSync(join(tmpdir(), "roundtable-postgres-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The environment of the run, less what decides which database it has. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env))
		if (value !== undefined && key !== "PG_BIN") env[key] = value;
	delete env.ROUNDTABLE_TEST_DATABASE_URL;
	return { ...env, ...extra };
}

interface Run {
	exitCode: number;
	output: string;
}

/** Runs `bun test` over a test file that prints what it saw as `seen <json>`, with `preload` as its preload. */
async function run(
	name: string,
	preload: string,
	body: string,
	env: Record<string, string>,
): Promise<Run> {
	const dir = join(root, name);
	mkdirSync(dir);
	writeFileSync(join(dir, "preload.ts"), preload);
	writeFileSync(
		join(dir, "seen.test.ts"),
		`import { describe, test } from "bun:test";
import * as testing from ${JSON.stringify(ENTRY)};
import { SQL } from "bun";
test("seen", async () => {
${body}
});
`,
	);
	const child = Bun.spawn(
		[
			process.execPath,
			"test",
			"--preload",
			join(dir, "preload.ts"),
			join(dir, "seen.test.ts"),
		],
		{ cwd: dir, env: cleanEnv(env), stdout: "pipe", stderr: "pipe" },
	);
	const [out, err, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, output: out + err };
}

const seenOf = (output: string): Record<string, unknown> => {
	const line = output.split("\n").find((each) => each.startsWith("seen "));
	if (!line) throw new Error(`the run printed nothing seen:\n${output}`);
	return JSON.parse(line.slice("seen ".length)) as Record<string, unknown>;
};

const HAS_PG = Bun.which("initdb") !== null || process.env.PG_BIN !== undefined;
const usePg = (options: string) =>
	`import { usePostgresForTests } from ${JSON.stringify(ENTRY)};
await usePostgresForTests(${options});
`;

describe("requireDatabase", () => {
	test("gives the URL of the run, and throws naming how to provide one when it has none", async () => {
		const without = await run(
			"require-none",
			"",
			`let message = "";
try { testing.requireDatabase(); } catch (error) { message = (error as Error).message; }
console.log("seen " + JSON.stringify({ message }));`,
			{},
		);
		const { message } = seenOf(without.output) as { message: string };
		expect(message).toContain("ROUNDTABLE_TEST_DATABASE_URL");
		expect(message).toContain("usePostgresForTests");
		const given = await run(
			"require-given",
			"",
			`console.log("seen " + JSON.stringify({ url: testing.requireDatabase() }));`,
			{ ROUNDTABLE_TEST_DATABASE_URL: "postgres://u@127.0.0.1:1/x" },
		);
		expect(seenOf(given.output).url).toBe("postgres://u@127.0.0.1:1/x");
	});
});

describe("usePostgresForTests", () => {
	test.skipIf(!HAS_PG)(
		"starts a throwaway PostgreSQL the tests can query, sets the live exports and variable, and stops it after the run",
		async () => {
			const started = await run(
				"starts",
				usePg("{ require: true }"),
				`const sql = new SQL(testing.requireDatabase(), { max: 1 });
const [row] = await sql\`SELECT 1 AS one\`;
await sql.close();
console.log("seen " + JSON.stringify({
	url: testing.testDatabaseUrl,
	env: process.env.ROUNDTABLE_TEST_DATABASE_URL,
	one: row.one,
	describeDbOn: testing.describeDb === describe,
}));`,
				{},
			);
			expect(started.exitCode).toBe(0);
			const seen = seenOf(started.output);
			expect(seen.url).toMatch(
				/^postgres:\/\/postgres@127\.0\.0\.1:\d+\/postgres$/,
			);
			expect(seen.env).toBe(seen.url);
			expect(seen.one).toBe(1);
			expect(seen.describeDbOn).toBe(true);
			// The run is over, so the server it started is gone: nothing accepts on its port.
			const { port } = new URL(String(seen.url));
			await expect(
				Bun.connect({
					hostname: "127.0.0.1",
					port: Number(port),
					socket: { data: () => undefined },
				}),
			).rejects.toThrow();
		},
		60_000,
	);

	test("does nothing when the run already names a database", async () => {
		const given = await run(
			"already",
			usePg("{ require: true }"),
			`console.log("seen " + JSON.stringify({ url: testing.testDatabaseUrl }));`,
			{ ROUNDTABLE_TEST_DATABASE_URL: "postgres://u@127.0.0.1:1/named" },
		);
		expect(given.exitCode).toBe(0);
		expect(seenOf(given.output).url).toBe("postgres://u@127.0.0.1:1/named");
	});

	test("does nothing when initdb and postgres are not found and require is off, and throws naming how to fix it when it is on", async () => {
		const empty = join(root, "no-bin");
		mkdirSync(empty);
		const env = { PATH: empty };
		const off = await run(
			"missing-off",
			usePg("{ binDirs: [] }"),
			`console.log("seen " + JSON.stringify({ url: testing.testDatabaseUrl }));`,
			env,
		);
		expect(off.exitCode).toBe(0);
		expect(seenOf(off.output).url).toBe("");
		const on = await run(
			"missing-on",
			usePg("{ binDirs: [], require: true }"),
			`console.log("seen " + JSON.stringify({}));`,
			env,
		);
		expect(on.exitCode).not.toBe(0);
		expect(on.output).toContain("this run needs PostgreSQL");
		expect(on.output).toContain("PG_BIN");
	});
});
