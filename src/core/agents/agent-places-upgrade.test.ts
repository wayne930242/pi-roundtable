import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { SQL } from "bun";
import {
	convergeLegacyChannelPlaces,
	LEGACY_CHANNEL_SURFACE,
} from "../db/legacy-channels.ts";
import { type Migration, migrate } from "../db/migrations.ts";
import { moveTeam } from "../db/team-move.ts";
import { describeDb, migratedPool } from "../testing/database.ts";
import { PgAgentStore } from "./agent-store.ts";

const HOME = "900000000000000201";
const OTHER = "900000000000000202";
const FORMER = "900000000000000203";
const LOCAL = "local";
const SURFACE = LEGACY_CHANNEL_SURFACE;

const PLACE_MIGRATIONS = ["agent-places", "agent-places-from-channels"];
const TABLES = [
	"agent_places",
	"agents",
	"agent_groups",
	"agent_group_messages",
	"agent_group_cursors",
];

/** The migrations as 0.43 declared them: the store's list without the two place migrations. */
const before = (team: string): Migration[] =>
	PgAgentStore.migrations(team).filter(
		(migration) => !PLACE_MIGRATIONS.includes(migration.name),
	);

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("agent places: storage", () => {
	let sql: SQL;

	const agent = (
		team: string,
		name: string,
		channel: string | null,
		status = "active",
	) =>
		sql`INSERT INTO agents (guild_id, name, display_name, prompt, avatar_prompt, channel_id, status)
			VALUES (${team}, ${name}, ${name}, 'p', '', ${channel}, ${status})`;
	const group = (team: string, name: string, channel: string | null) =>
		sql`INSERT INTO agent_groups (guild_id, name, display_name, channel_id, members, host)
			VALUES (${team}, ${name}, ${name}, ${channel}, 'a,b', 'a')`;
	const places = async () => {
		const rows: Record<string, string>[] = await sql`
			SELECT team_id, kind, name, surface, external_id FROM agent_places
			ORDER BY team_id, kind, name, surface`;
		return rows.map((row) => [
			row.team_id,
			row.kind,
			row.name,
			row.surface,
			row.external_id,
		]);
	};
	/** A database a 0.43 host left: the store's tables without the place table, holding every upgrade case. */
	const seed043 = async () => {
		await agent(HOME, "infra", "10");
		await agent(HOME, "old", "11", "archived");
		await agent(HOME, "free", null);
		await group(HOME, "ops", "20");
		// A team moved from a former guild: 0.43's team-move cleared the ids of the rows it moved.
		await agent(LOCAL, "moved", null);
		await group(LOCAL, "council", null);
		await agent(OTHER, "elsewhere", "30");
	};
	const upgrade = (team = HOME) => migrate(sql, PgAgentStore.migrations(team));

	beforeEach(async () => {
		sql?.close();
		const admin = await migratedPool();
		for (const table of TABLES)
			await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
		await admin.close();
		sql = await migratedPool(...before(HOME));
	});

	afterAll(async () => {
		if (!sql) return;
		// The tables stay, as a later host boot finds them in the migration ledger; only their rows go.
		await migrate(sql, PgAgentStore.migrations(HOME));
		for (const table of TABLES.slice().reverse())
			await sql.unsafe(`DELETE FROM ${table}`);
		await sql.close();
	});

	test("the list adds the two place migrations after 0.43's, the second at every boot", () => {
		const names = PgAgentStore.migrations(HOME).map((m) => m.name);
		expect(names.slice(0, before(HOME).length)).toEqual(
			before(HOME).map((m) => m.name),
		);
		expect(names.slice(before(HOME).length)).toEqual(PLACE_MIGRATIONS);
		const added = PgAgentStore.migrations(HOME).slice(before(HOME).length);
		expect(added.map((m) => m.runs ?? "once")).toEqual(["once", "every-boot"]);
	});

	test("a fresh database gets an empty table", async () => {
		await upgrade();
		expect(await places()).toEqual([]);
	});

	test("an upgraded database holds one place per channel id of the booting team", async () => {
		await seed043();
		await upgrade();
		expect(await places()).toEqual([
			[HOME, "agent", "infra", SURFACE, "10"],
			[HOME, "agent", "old", SURFACE, "11"],
			[HOME, "group", "ops", SURFACE, "20"],
		]);
	});

	test("a boot converges its own team only: the rows of another team's host in the same database stay as they are", async () => {
		await seed043();
		await upgrade(OTHER);
		// The other team's host holds a place its column does not show yet, as in the middle of its write.
		await sql`UPDATE agent_places SET external_id = '99' WHERE team_id = ${OTHER}`;
		await upgrade(HOME);
		expect(await places()).toEqual([
			[HOME, "agent", "infra", SURFACE, "10"],
			[HOME, "agent", "old", SURFACE, "11"],
			[HOME, "group", "ops", SURFACE, "20"],
			[OTHER, "agent", "elsewhere", SURFACE, "99"],
		]);
	});

	test("the team with no channel ids, of a host with no agent guild, gets no place", async () => {
		await seed043();
		await upgrade(LOCAL);
		expect((await places()).filter(([team]) => team === LOCAL)).toEqual([]);
	});

	test("a second boot changes nothing", async () => {
		await seed043();
		await upgrade();
		const first =
			await sql`SELECT * FROM agent_places ORDER BY team_id, kind, name`;
		await upgrade();
		expect(
			await sql`SELECT * FROM agent_places ORDER BY team_id, kind, name`,
		).toEqual(first);
	});

	test("the next boot makes the table equal the columns again after a build that wrote only the columns", async () => {
		await seed043();
		await upgrade();
		await sql`UPDATE agents SET channel_id = '99' WHERE name = 'infra'`;
		await sql`UPDATE agents SET channel_id = NULL WHERE name = 'old'`;
		await agent(HOME, "fresh", "12");
		await sql`DELETE FROM agent_groups WHERE name = 'ops'`;
		await upgrade();
		expect(await places()).toEqual([
			[HOME, "agent", "fresh", SURFACE, "12"],
			[HOME, "agent", "infra", SURFACE, "99"],
		]);
	});

	test("a channel moved from one owner to another follows it", async () => {
		await seed043();
		await upgrade();
		await sql`UPDATE agents SET channel_id = NULL WHERE name = 'infra'`;
		await sql`UPDATE agents SET channel_id = '10' WHERE name = 'free'`;
		await upgrade();
		expect((await places()).filter(([, , , , id]) => id === "10")).toEqual([
			[HOME, "agent", "free", SURFACE, "10"],
		]);
	});

	test("a channel id two owners of one team hold stays with the first, and a warning names both", async () => {
		await agent(HOME, "twin", "50");
		await group(HOME, "twins", "50");
		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await upgrade();
			expect(await places()).toEqual([[HOME, "agent", "twin", SURFACE, "50"]]);
			expect(warn).toHaveBeenCalledTimes(1);
			const [message] = warn.mock.calls[0] as [string];
			expect(message).toContain('group "twins"');
			expect(message).toContain('agent "twin"');
		} finally {
			warn.mockRestore();
		}
	});

	test("the store writes a place with the column in one write, and reads them back", async () => {
		await upgrade();
		const store = await PgAgentStore.attach(sql, HOME);
		await store.createAgent({
			name: "alpha",
			displayName: "Alpha",
			prompt: "p",
			channelId: "1",
		});
		await store.createAgent({ name: "beta", displayName: "Beta", prompt: "p" });
		expect(store.places.on("agent", "alpha", SURFACE)).toBe("1");
		expect(store.places.on("agent", "beta", SURFACE)).toBeUndefined();
		expect(store.places.ownerOf(SURFACE, "1")).toEqual({
			kind: "agent",
			name: "alpha",
		});
		expect(await places()).toEqual([[HOME, "agent", "alpha", SURFACE, "1"]]);

		await store.updateAgent("beta", { channelId: "2" });
		await store.updateAgent("alpha", { displayName: "Alpha 2", prompt: "q" });
		expect(await places()).toEqual([
			[HOME, "agent", "alpha", SURFACE, "1"],
			[HOME, "agent", "beta", SURFACE, "2"],
		]);

		const grouped = await store.createGroup({
			name: "pair",
			displayName: "Pair",
			channelId: "3",
			members: ["alpha", "beta"],
			host: "alpha",
		});
		expect(grouped.channelId).toBe("3");
		expect(store.places.ownerOf(SURFACE, "3")).toEqual({
			kind: "group",
			name: "pair",
		});

		// An archived owner keeps its place, which restore brings back or replaces.
		await store.archiveGroup("pair");
		await store.archiveAgent("alpha");
		expect(store.places.on("agent", "alpha", SURFACE)).toBe("1");
		await store.restoreAgent("alpha", "4");
		await store.restoreGroup("pair", "5");
		expect(await places()).toEqual([
			[HOME, "agent", "alpha", SURFACE, "4"],
			[HOME, "agent", "beta", SURFACE, "2"],
			[HOME, "group", "pair", SURFACE, "5"],
		]);
		expect(store.places.ownerOf(SURFACE, "1")).toBeUndefined();

		// A fresh store reads the same rows, and the columns still say the same.
		const again = await PgAgentStore.attach(sql, HOME);
		expect(again.places.of("group", "pair")).toEqual([
			{ kind: "group", name: "pair", surface: SURFACE, externalId: "5" },
		]);
		expect(again.agent("alpha")?.channelId).toBe("4");

		await store.archiveGroup("pair");
		await store.deleteGroup("pair");
		await store.archiveAgent("beta");
		await store.deleteAgent("beta");
		expect(await places()).toEqual([[HOME, "agent", "alpha", SURFACE, "4"]]);
		expect(store.places.of("agent", "beta")).toEqual([]);
		await upgrade();
		expect(await places()).toEqual([[HOME, "agent", "alpha", SURFACE, "4"]]);
	});

	test("seeds with a channel id get a place; a seed that exists already does not change it", async () => {
		await upgrade();
		const store = await PgAgentStore.attach(sql, HOME);
		await store.seed([
			{ name: "seeded", displayName: "Seeded", prompt: "p", channelId: "7" },
		]);
		await store.seed([
			{ name: "seeded", displayName: "Seeded", prompt: "p", channelId: "8" },
		]);
		expect(await places()).toEqual([[HOME, "agent", "seeded", SURFACE, "7"]]);
	});

	test("a write that gives an owner the channel id another owner of the team holds warns and keeps the column, without a row", async () => {
		await upgrade();
		const store = await PgAgentStore.attach(sql, HOME);
		await store.createAgent({
			name: "alpha",
			displayName: "Alpha",
			prompt: "p",
			channelId: "1",
		});
		await store.createAgent({ name: "beta", displayName: "Beta", prompt: "p" });
		await store.createGroup({
			name: "pair",
			displayName: "Pair",
			channelId: "2",
			members: ["alpha", "beta"],
			host: "alpha",
		});
		await store.archiveGroup("pair");
		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await store.restoreGroup("pair", "1");
			expect(warn).toHaveBeenCalledTimes(1);
			const [message] = warn.mock.calls[0] as [string];
			expect(message).toContain('group "pair"');
			expect(message).toContain('agent "alpha"');
		} finally {
			warn.mockRestore();
		}
		const [column]: { channel_id: string }[] =
			await sql`SELECT channel_id FROM agent_groups WHERE name = 'pair'`;
		expect(column?.channel_id).toBe("1");
		// The group's earlier place is gone with its old id, and the agent keeps the id.
		expect(await places()).toEqual([[HOME, "agent", "alpha", SURFACE, "1"]]);
		expect(store.places.of("group", "pair")).toEqual([]);
		expect(store.places.ownerOf(SURFACE, "1")).toEqual({
			kind: "agent",
			name: "alpha",
		});
	});

	test("a boot of Merlin's shape writes no place rows twice: a record kept under the former guild gets none", async () => {
		// Team `local`, no agent guild; the former guild's record "infra" could not move, as `local` holds one.
		await agent(LOCAL, "infra", null);
		await agent(FORMER, "infra", "10");
		await group(FORMER, "ops", "20");
		const boot = () =>
			migrate(sql, [
				...PgAgentStore.migrations(LOCAL),
				moveTeam({
					from: [FORMER],
					to: LOCAL,
					clearChannels: true,
					places: [{ surface: SURFACE }],
				}),
			]);
		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await boot();
			await sql`CREATE TABLE place_write_log (op text NOT NULL)`;
			await sql.unsafe(`
				CREATE FUNCTION place_write_log_fn() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN INSERT INTO place_write_log VALUES (TG_OP); RETURN NULL; END $$`);
			await sql`CREATE TRIGGER place_write_log_trg AFTER INSERT OR UPDATE OR DELETE ON agent_places
				FOR EACH ROW EXECUTE FUNCTION place_write_log_fn()`;
			await boot();
			const writes = await sql`SELECT op FROM place_write_log`;
			expect(writes).toEqual([]);
			expect(await places()).toEqual([]);
		} finally {
			warn.mockRestore();
			await sql`DROP TRIGGER IF EXISTS place_write_log_trg ON agent_places`;
			await sql`DROP FUNCTION IF EXISTS place_write_log_fn()`;
			await sql`DROP TABLE IF EXISTS place_write_log`;
		}
	});

	describe("moveTeam", () => {
		/** Rows of a former team and of the team itself, with their places made by the convergence. */
		const seedMove = async () => {
			await agent(FORMER, "moved", "100");
			await agent(FORMER, "both", "101");
			await agent(LOCAL, "both", "102");
			await group(FORMER, "council", "200");
			await agent(OTHER, "elsewhere", "300");
			await upgrade(LOCAL);
			for (const team of [FORMER, OTHER])
				await convergeLegacyChannelPlaces(team)(sql);
			// A place of a surface the team code has never heard of.
			await sql`INSERT INTO agent_places (team_id, kind, name, surface, external_id)
				VALUES (${FORMER}, 'agent', 'moved', 'pager', 'p-1')`;
		};

		test("moveTeam moves the place rows with the rest of a former team's rows", async () => {
			await seedMove();
			await moveTeam({ from: [FORMER], to: LOCAL }).up(sql);
			// "both" stays under the former id: the team holds that key already.
			expect(await places()).toEqual([
				[OTHER, "agent", "elsewhere", SURFACE, "300"],
				[FORMER, "agent", "both", SURFACE, "101"],
				[LOCAL, "agent", "both", SURFACE, "102"],
				[LOCAL, "agent", "moved", SURFACE, "100"],
				[LOCAL, "agent", "moved", "pager", "p-1"],
				[LOCAL, "group", "council", SURFACE, "200"],
			]);
		});

		test("moveTeam drops the moved places of a surface whose space was not the team's, and keeps the others", async () => {
			await seedMove();
			await moveTeam({
				from: [FORMER],
				to: LOCAL,
				discordGuild: OTHER,
				places: [{ surface: SURFACE, keep: OTHER }],
			}).up(sql);
			expect(await places()).toEqual([
				[OTHER, "agent", "elsewhere", SURFACE, "300"],
				[LOCAL, "agent", "both", SURFACE, "102"],
				[LOCAL, "agent", "moved", "pager", "p-1"],
			]);
			// The columns of the moved rows were cleared, so the next convergence agrees; the row that
			// stayed under the former id keeps its column, and gets no place: it is not the team's.
			await upgrade(LOCAL);
			expect(await places()).toEqual([
				[OTHER, "agent", "elsewhere", SURFACE, "300"],
				[LOCAL, "agent", "both", SURFACE, "102"],
				[LOCAL, "agent", "moved", "pager", "p-1"],
			]);
		});

		test("moveTeam keeps the places of the former id that is the team's space", async () => {
			await seedMove();
			await moveTeam({
				from: [FORMER],
				to: LOCAL,
				discordGuild: FORMER,
				places: [{ surface: SURFACE, keep: FORMER }],
			}).up(sql);
			expect(
				(await places()).filter(
					([team, , , surface]) => team === LOCAL && surface === SURFACE,
				),
			).toEqual([
				[LOCAL, "agent", "both", SURFACE, "102"],
				[LOCAL, "agent", "moved", SURFACE, "100"],
				[LOCAL, "group", "council", SURFACE, "200"],
			]);
		});

		test("a team without channels loses the places of the surface, its own and the moved", async () => {
			await seedMove();
			await moveTeam({
				from: [FORMER],
				to: LOCAL,
				clearChannels: true,
				places: [{ surface: SURFACE }],
			}).up(sql);
			expect(await places()).toEqual([
				[OTHER, "agent", "elsewhere", SURFACE, "300"],
				[LOCAL, "agent", "moved", "pager", "p-1"],
			]);
			await upgrade(LOCAL);
			expect(
				(await places()).filter(
					([team, , , surface]) => team === LOCAL && surface === SURFACE,
				),
			).toEqual([]);
		});

		test("a second moveTeam changes nothing, and a place id the team holds already stays where it is", async () => {
			await seedMove();
			await sql`INSERT INTO agent_places (team_id, kind, name, surface, external_id)
				VALUES (${LOCAL}, 'agent', 'other-owner', 'pager', 'p-1')`;
			const warn = spyOn(console, "warn").mockImplementation(() => undefined);
			try {
				const migration = moveTeam({ from: [FORMER], to: LOCAL });
				await migration.up(sql);
				const first = await places();
				await migration.up(sql);
				expect(await places()).toEqual(first);
				expect(first).toContainEqual([
					FORMER,
					"agent",
					"moved",
					"pager",
					"p-1",
				]);
				// The place stays behind because the team holds its id, and a warning names it.
				const messages = warn.mock.calls.map(([text]) => String(text));
				expect(
					messages.some(
						(text) => text.includes('"agent_places"') && text.includes("pager"),
					),
				).toBe(true);
			} finally {
				warn.mockRestore();
			}
		});
	});
});
