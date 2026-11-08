import { expect, test } from "bun:test";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import { describeDb } from "../testing/database.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import { fx, useTeamFixture } from "./agent-team-fixture.ts";
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
		const routes = new Routes({
			store: fx.store,
			roomSurfaces: () => fx.surfaces.roomSurfaces(),
		});
		expect(routes.primary("infra")).toBe(room("infra"));
		expect(routes.placeOn("infra", PAGER)).toBe(room("infra"));
		expect(routes.of("infra", "opening", room("doctor"))).toBe(room("infra"));
		const infra = fx.store.agent("infra");
		if (!infra) throw new Error("the fixture has an infra agent");
		const ctx = {
			store: fx.store,
			roomSurfaces: fx.surfaces.roomSurfaces(),
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
