import { expect, test } from "bun:test";
import { discordKey } from "../contract/discord-key.ts";
import { describeDb } from "../testing/database.ts";
import {
	agentChannel,
	fx,
	restart,
	useTeamFixture,
} from "./agent-team-fixture.ts";

/**
 * A team whose id stays while its agent guild changes: the channels it stored are another
 * server's. At start Discord's provider calls them foreign, which is no deletion: nobody is
 * archived, the row goes, and the place is made again in the agent guild.
 */
// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("a stored channel of another server at start", () => {
	useTeamFixture();

	test("an agent keeps its standing and gets a new channel in the agent guild", async () => {
		const old = fx.store.agent("doctor")?.channelId ?? "";
		fx.channels.foreign.add(old);
		const made = fx.channels.created.length;
		await restart();
		const doctor = fx.store.agent("doctor");
		expect(doctor?.status).toBe("active");
		expect(doctor?.channelId).toBeDefined();
		expect(doctor?.channelId).not.toBe(old);
		expect(fx.store.places.on("agent", "doctor", "discord")).toBe(
			doctor?.channelId as string,
		);
		expect(fx.channels.created.length).toBe(made + 1);
		expect(fx.team.owns(discordKey(old))).toBeUndefined();
		expect(fx.team.owns(agentChannel("doctor"))).toBe("agent");
	});

	test("a group is not archived either, and gets a new channel", async () => {
		await fx.team.createGroup({
			name: "pair",
			displayName: "Pair",
			members: ["infra", "doctor"],
		});
		const old = fx.store.group("pair")?.channelId ?? "";
		fx.channels.foreign.add(old);
		await restart();
		const pair = fx.store.group("pair");
		expect(pair?.status).toBe("active");
		expect(pair?.channelId).not.toBe(old);
		expect(fx.channels.categoryOf(pair?.channelId ?? "")).toBe("Groups");
		expect(fx.team.owns(discordKey(old))).toBeUndefined();
	});

	test("a channel deleted while the team was down still archives its owner", async () => {
		const old = fx.store.agent("doctor")?.channelId ?? "";
		fx.channels.deleted.add(old);
		await restart();
		expect(fx.store.agent("doctor")?.status).toBe("archived");
	});
});
