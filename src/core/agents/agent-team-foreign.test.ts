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

describeDb(
	"restoring an owner whose archived channel is another server's",
	() => {
		useTeamFixture();

		test("the channel is not moved there: the agent gets a new one in the agent guild", async () => {
			await fx.team.archive(undefined, "doctor");
			const old = fx.store.agent("doctor")?.channelId ?? "";
			fx.channels.foreign.add(old);
			const made = fx.channels.created.length;
			await fx.team.restore("doctor");
			const doctor = fx.store.agent("doctor");
			expect(doctor?.status).toBe("active");
			expect(doctor?.channelId).toBeDefined();
			expect(doctor?.channelId).not.toBe(old);
			expect(fx.channels.created.length).toBe(made + 1);
			// The old channel stays in the other server's Archive, not moved into its Agents.
			expect(fx.channels.categoryOf(old)).toBe("Archive");
			expect(fx.channels.categoryOf(doctor?.channelId ?? "")).toBe("Agents");
		});

		test("a place the provider cannot check is taken as it is: the same channel is brought back", async () => {
			await fx.team.archive(undefined, "doctor");
			const same = fx.store.agent("doctor")?.channelId ?? "";
			fx.channels.failing.add(same);
			const made = fx.channels.created.length;
			await fx.team.restore("doctor");
			expect(fx.store.agent("doctor")?.status).toBe("active");
			expect(fx.store.agent("doctor")?.channelId).toBe(same);
			expect(fx.channels.created.length).toBe(made);
		});

		test("a channel of the agent guild is brought back as before", async () => {
			await fx.team.archive(undefined, "doctor");
			const same = fx.store.agent("doctor")?.channelId ?? "";
			const made = fx.channels.created.length;
			await fx.team.restore("doctor");
			expect(fx.store.agent("doctor")?.channelId).toBe(same);
			expect(fx.channels.created.length).toBe(made);
		});
	},
);

describeDb("a stored channel that cannot be checked at start", () => {
	useTeamFixture();

	test("start finishes: the place stays, nobody is archived, and others still get theirs", async () => {
		const stuck = fx.store.agent("doctor")?.channelId ?? "";
		fx.channels.failing.add(stuck);
		await fx.store.clearPlace("agent", "infra", "discord");
		const made = fx.channels.created.length;
		await restart();
		expect(fx.store.agent("doctor")?.status).toBe("active");
		expect(fx.store.places.on("agent", "doctor", "discord")).toBe(stuck);
		expect(fx.channels.created.length).toBe(made + 1);
	});
});
