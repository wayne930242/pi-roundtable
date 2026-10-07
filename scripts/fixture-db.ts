/**
 * Writes src/core/testing/fixtures/db-<version>.sql: the database a single-owner Discord host of
 * this version leaves behind, as its migrations build it, with representative rows in every table
 * that names a person. Later versions' migrations are tested against it.
 *
 *   bun scripts/fixture-db.ts <postgres url of a server where you may create databases>
 *
 * It creates a scratch database on that server, dumps it with pg_dump, and drops it again. Every
 * id is a made-up one scan-public lets through.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SQL } from "bun";
import { migrateDatabase } from "../src/core/db/migrations.ts";
import { defineRoundtable } from "../src/core/define-roundtable.ts";
import { silentLogger } from "../src/core/log.ts";

/** The people of the fixture, as 0.8 stored them. */
export const FIXTURE = {
	owner: "966666600000000001",
	members: ["966666600000000003", "966666600000000005"],
	remote: "remote-mcp",
	web: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20:user-7",
	guild: "966666600000000002",
} as const;

/** The plugins, with their names and migrations, of a single-owner Discord host. */
async function hostPlugins(url: string) {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-fixture-"));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const defined = await defineRoundtable(
		{
			owner: { id: FIXTURE.owner, name: "Ada" },
			discord: {
				token: "token",
				guild: FIXTURE.guild,
				entryChannel: "966666600000000004",
			},
			database: { url },
			dataDir: dir,
			model: "anthropic/claude-sonnet-5-5",
			http: { publicUrl: "https://bot.example.com", port: 8080 },
		},
		{ logger: silentLogger(), modelRuntime },
	);
	return defined.plugins;
}

/** The rows: memory, schedules, conversations, and held actions of the owner and others. */
async function seed(sql: SQL): Promise<void> {
	const { owner, members, remote, web } = FIXTURE;
	const [memberA, memberB] = members;
	for (const [speaker, fact, kind] of [
		[owner, "Ada drinks oolong tea", "core"],
		[owner, "Ada moved the standup to Tuesdays", "note"],
		[memberA, "Kai studies for the finals", "core"],
		[memberB, "Noa plans a trip", "core"],
	] as const)
		await sql`
			INSERT INTO owner_memory (fact, kind, speaker_id, created_at, updated_at)
			VALUES (${fact}, ${kind}, ${speaker}, '2026-09-01T09:00:00Z', '2026-09-01T09:00:00Z')`;
	const recurrence = JSON.stringify({
		kind: "every",
		time: "09:00",
		everyDays: 1,
		startDate: "2026-09-01",
	});
	for (const [channel, by, name, tier] of [
		["discord:966666600000000011", owner, "Ada", "owner"],
		["discord:966666600000000012", memberA, "Kai", "member"],
		["mcp:remote", remote, "Remote", "owner"],
	] as const)
		await sql`
			INSERT INTO schedules (channel_key, mode, title, prompt, recurrence, next_run,
				created_by_id, created_by_name, created_tier, created_at)
			VALUES (${channel}, 'owner', ${`${name}'s daily check`}, 'Check the news.', ${recurrence},
				'2026-10-08T09:00:00Z', ${by}, ${name}, ${tier}, '2026-09-01T09:00:00Z')`;
	await sql`
		INSERT INTO conversations (key, surface, kind, principal_id, visibility, title, created_at, last_active_at)
		VALUES
			('web:c-1', 'web', 'chat', ${web}, 'private', 'Trip plans', '2026-09-01T09:00:00Z', '2026-09-02T09:00:00Z'),
			('web:c-2', 'web', 'chat', NULL, 'shared', NULL, '2026-09-01T09:00:00Z', '2026-09-02T09:00:00Z')`;
	const calls = JSON.stringify([
		{
			tool: "bash",
			input: '{"command":"rm -rf build"}',
			action: "Remove build",
		},
	]);
	await sql`
		INSERT INTO held_actions (channel_key, selection_id, held_at, calls, speaker_id, speaker_held_at)
		VALUES
			('discord:966666600000000012', 'agent', '2026-09-01T09:00:00Z', ${calls}, ${memberA}, '2026-09-01T09:00:00Z'),
			('discord:966666600000000013', 'agent', '2026-09-01T09:00:00Z', ${calls}, NULL, NULL)`;
}

/** pg_dump's output without what binds a session or a server version: settings and meta-commands. */
function portable(dump: string): string {
	return dump
		.split("\n")
		.filter(
			(line) =>
				!line.startsWith("SET ") &&
				!line.startsWith("\\") &&
				!line.startsWith("--") &&
				!line.startsWith("SELECT pg_catalog.set_config"),
		)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function main(): Promise<void> {
	const admin = process.argv[2];
	if (!admin)
		throw new Error("usage: bun scripts/fixture-db.ts <postgres url>");
	let url: URL;
	try {
		url = new URL(admin);
	} catch {
		throw new Error(`not a postgres url: ${admin}`);
	}
	const manifest: { version: string } = await Bun.file("package.json").json();
	const name = `roundtable_fixture_${Date.now()}`;
	url.pathname = `/${name}`;
	const server = new SQL(admin, { max: 1 });
	await server.unsafe(`CREATE DATABASE ${name}`);
	try {
		await migrateDatabase(url.href, await hostPlugins(url.href));
		const sql = new SQL(url.href, { max: 1 });
		try {
			await seed(sql);
		} finally {
			await sql.close();
		}
		const dump = spawnSync(
			"pg_dump",
			[
				"--column-inserts",
				"--no-owner",
				"--no-privileges",
				"--no-comments",
				url.href,
			],
			{ encoding: "utf8", env: { ...process.env, PGTZ: "UTC" } },
		);
		if (dump.status !== 0) throw new Error(`pg_dump failed: ${dump.stderr}`);
		const out = `src/core/testing/fixtures/db-${manifest.version}.sql`;
		writeFileSync(
			out,
			`-- The database of a single-owner Discord host of pi-roundtable ${manifest.version}, written by scripts/fixture-db.ts.\n${portable(dump.stdout)}\n`,
		);
		console.log(`wrote ${out}`);
	} finally {
		await server.unsafe(`DROP DATABASE IF EXISTS ${name}`);
		await server.close();
	}
}

if (import.meta.main) await main();
