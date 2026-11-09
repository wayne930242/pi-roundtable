import { beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import {
	describeDb,
	TEST_GUILD,
	testDatabaseUrl,
} from "../testing/database.ts";
import { FakePager } from "../testing/fake-pager-places.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import { fx, restart, settle, useTeamFixture } from "./agent-team-fixture.ts";
import { messageTarget } from "./message-target.ts";
import { Routes } from "./routes.ts";
import { agentRoomKey, groupRoomKey } from "./team-keys.ts";

/**
 * D4: the team works for any channel type that hosts rooms. This one is a channel type the core
 * has never heard of, `pager`, whose only declaration is that it hosts agent rooms: it gets its
 * agents' places (keys, owner, routes, replies, groups) with no change to the core. A change that
 * lets a place depend on the channel type's name fails here.
 */
const PAGER = "pager";
const room = (name: string) => agentRoomKey(PAGER, name);

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("a channel type that only hosts rooms", () => {
	useTeamFixture({ local: true });

	const adopt = () => {
		fx.surfaces.rooms = [PAGER];
	};

	test("its agents and groups have places the team owns", async () => {
		adopt();
		expect(fx.team.roomsOf("infra")).toEqual([room("infra")]);
		expect(fx.team.owns(room("infra"))).toBe("agent");
		await fx.team.createGroup({
			name: "crew",
			displayName: "Crew",
			members: ["infra", "doctor"],
		});
		expect(fx.team.owns(groupRoomKey(PAGER, "crew"))).toBe("group");
		expect(fx.team.channelOf("infra", room("doctor"))).toBe(room("infra"));
	});

	test("an owner message in a place runs there, and the reply goes back to its channel type", async () => {
		adopt();
		await fx.team.answerOwner(
			room("infra"),
			OWNER_SPEAKER,
			"hi",
			"hi",
			NO_ATTACHMENTS,
		);
		expect(fx.runtime.turns.map((t) => t.agent?.session)).toEqual([
			room("infra"),
		]);
		expect(fx.surfaces.texts(room("infra"))).toEqual(["infra: infra ok"]);
	});

	test("the routing table and a message between agents land in its places", () => {
		adopt();
		const routes = new Routes({ store: fx.store, places: fx.places });
		expect(routes.primary("infra")).toBe(room("infra"));
		expect(routes.placeOn("infra", PAGER)).toBe(room("infra"));
		expect(routes.of("infra", "opening", room("doctor"))).toBe(room("infra"));
		const infra = fx.store.agent("infra");
		if (!infra) throw new Error("the fixture has an infra agent");
		const ctx = {
			store: fx.store,
			places: fx.places,
			latest: undefined,
			routes,
		};
		expect(
			messageTarget({ ...ctx, from: room("doctor") }, infra, undefined),
		).toBe(room("infra"));
		expect(messageTarget({ ...ctx, from: room("doctor") }, infra, PAGER)).toBe(
			room("infra"),
		);
	});
});

/**
 * D2: a channel type that makes places of its own. `pager` is one the core has never heard of;
 * its provider is stored: the places it made are rows of `agent_places`, with ids of its own. They
 * are keys, owners, routes and reply targets of the team with no branch for it in the core.
 */
const PAGE = (id: string): ChannelKey => `pager:${id}`;

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("a channel type that makes places of its own", () => {
	useTeamFixture({ local: true });

	let pager: FakePager;
	beforeEach(() => {
		pager = new FakePager();
		fx.stored.push(pager.provider);
	});

	/** The pager made `id` for the agent or group: a row of the place table, which the team reads. */
	const bind = async (kind: "agent" | "group", name: string, id: string) => {
		const sql = new SQL(testDatabaseUrl);
		try {
			await sql`
				INSERT INTO agent_places (team_id, kind, name, surface, external_id)
				VALUES (${TEST_GUILD}, ${kind}, ${name}, 'pager', ${id})`;
		} finally {
			await sql.close();
		}
		await fx.store.places.reload();
	};

	test("its places are keys of its agents and groups, before their rooms, and the team owns them", async () => {
		await bind("agent", "infra", "pg-1");
		await bind("agent", "doctor", "pg-2");
		expect(fx.team.roomsOf("infra")).toEqual([PAGE("pg-1"), "app:agent.infra"]);
		expect(fx.team.placesOf("infra")).toEqual([
			{ surface: "pager", key: PAGE("pg-1") },
			{ surface: "app", key: "app:agent.infra" },
		]);
		expect(fx.team.owns(PAGE("pg-1"))).toBe("agent");
		expect(fx.team.owns(PAGE("pg-9"))).toBeUndefined();
		expect(fx.store.placeOwner(PAGE("pg-2"))).toEqual({
			kind: "agent",
			name: "doctor",
		});
		await fx.team.createGroup({
			name: "crew",
			displayName: "Crew",
			members: ["infra", "doctor"],
		});
		await bind("group", "crew", "pg-3");
		expect(fx.team.owns(PAGE("pg-3"))).toBe("group");
		expect(fx.team.roomsOf("crew")).toEqual([PAGE("pg-3"), "app:group.crew"]);
		const status = await fx.team.status();
		expect(status.agents.find((a) => a.name === "infra")?.places).toEqual([
			{ surface: "pager", key: PAGE("pg-1") },
			{ surface: "app", key: "app:agent.infra" },
		]);
		expect(status.groups.find((g) => g.name === "crew")?.places).toEqual([
			{ surface: "pager", key: PAGE("pg-3") },
			{ surface: "app", key: "app:group.crew" },
		]);
	});

	test("a group's seats and log in its place are named by the surface and the place's id", async () => {
		await fx.team.createGroup({
			name: "crew",
			displayName: "Crew",
			members: ["infra", "doctor"],
		});
		await bind("group", "crew", "pg-3");
		const crew = fx.store.group("crew");
		if (!crew) throw new Error("the group was made");
		expect(fx.places.seatKey(crew, "infra", PAGE("pg-3"))).toBe(
			"agentgroup:pager.pg-3.infra",
		);
		expect(fx.places.logName(crew, PAGE("pg-3"))).toBe("crew@pager");
		expect(fx.places.seatsOf(crew, "infra")).toEqual([
			"agentgroup:pager.pg-3.infra",
			"agentgroup:app.group.crew.infra",
		]);
		const infra = fx.store.agent("infra");
		if (!infra) throw new Error("the fixture has an infra agent");
		await bind("agent", "infra", "pg-1");
		expect(fx.places.groupScope(infra, crew, PAGE("pg-3"))).toEqual({
			name: "infra",
			session: "agentgroup:pager.pg-3.infra",
			home: PAGE("pg-1"),
			group: "crew",
		});
	});

	test("the routing table and a message between agents land in its places", async () => {
		await bind("agent", "infra", "pg-1");
		await bind("agent", "doctor", "pg-2");
		const { routes } = fx.team;
		// "Auto" prefers a stored place to a room, as Discord's channel is preferred.
		expect(routes.primary("infra")).toBe(PAGE("pg-1"));
		expect(routes.placeOn("infra", "pager")).toBe(PAGE("pg-1"));
		expect(routes.placeOn("infra", "app")).toBe("app:agent.infra");
		expect(routes.of("infra", "opening", PAGE("pg-2"))).toBe(PAGE("pg-1"));
		expect(routes.of("infra", "agentMessage", PAGE("pg-2"))).toBe(PAGE("pg-1"));
		expect(routes.of("infra", "agentMessage", "app:agent.doctor")).toBe(
			"app:agent.infra",
		);
		const infra = fx.store.agent("infra");
		if (!infra) throw new Error("the fixture has an infra agent");
		const ctx = {
			store: fx.store,
			places: fx.places,
			latest: undefined,
			routes,
		};
		expect(
			messageTarget({ ...ctx, from: PAGE("pg-2") }, infra, undefined),
		).toBe(PAGE("pg-1"));
		expect(
			messageTarget({ ...ctx, from: "app:agent.doctor" }, infra, "pager"),
		).toBe(PAGE("pg-1"));
		expect(messageTarget({ ...ctx, from: PAGE("pg-2") }, infra, "app")).toBe(
			"app:agent.infra",
		);
		expect(() =>
			messageTarget({ ...ctx, from: PAGE("pg-2") }, infra, "discord"),
		).toThrow("infra has no Discord channel");
		// A place of a surface nobody serves on this host is no key, owner or route.
		const sql = new SQL(testDatabaseUrl);
		await sql`
			INSERT INTO agent_places (team_id, kind, name, surface, external_id)
			VALUES (${TEST_GUILD}, 'agent', 'infra', 'unserved', 'u-1')`;
		await sql.close();
		await fx.store.places.reload();
		expect(fx.team.roomsOf("infra")).toEqual([PAGE("pg-1"), "app:agent.infra"]);
		expect(fx.team.owns("unserved:u-1")).toBeUndefined();
		expect(routes.placeOn("infra", "unserved")).toBeUndefined();
	});

	test("an owner message in a place runs there, and the reply goes back to that place", async () => {
		await bind("agent", "infra", "pg-1");
		await fx.team.answerOwner(
			PAGE("pg-1"),
			OWNER_SPEAKER,
			"hi",
			"hi",
			NO_ATTACHMENTS,
		);
		expect(fx.runtime.turns.map((t) => t.agent?.session)).toEqual([
			PAGE("pg-1"),
		]);
		expect(fx.surfaces.texts(PAGE("pg-1"))).toEqual(["infra: infra ok"]);
		await fx.team.startFresh(PAGE("pg-1"));
		expect(fx.runtime.fresh).toContain(PAGE("pg-1"));
	});

	test("a kept message for an agent in its place is replayed there, and one for a place nobody owns is dropped", async () => {
		await bind("agent", "infra", "pg-1");
		const kept = (channel: string) =>
			fx.store.outbox.keep({
				kind: "message",
				sender: "doctor",
				target: "infra",
				channel: channel as never,
				text: "check the disk",
				origin: "app:agent.doctor",
				speaker: OWNER_SPEAKER,
				messages: 0,
			});
		await kept(PAGE("pg-9"));
		await restart();
		expect(fx.runtime.turns).toHaveLength(0);
		await kept(PAGE("pg-1"));
		await restart();
		await settle();
		expect(fx.runtime.turns[0]).toMatchObject({ channel: PAGE("pg-1") });
		expect(fx.runtime.turns[0]?.text).toContain("check the disk");
	});
});
