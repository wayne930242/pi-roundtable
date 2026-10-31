import { expect, test } from "bun:test";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import { AgentError, ScheduleError } from "../domain/errors.ts";
import { describeDb, openTestStore, TEST_GUILD } from "../testing/database.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import { PgAgentStore } from "./agent-store.ts";
import {
	ENTRY,
	fx,
	removedSchedules,
	settle,
	useTeamFixture,
} from "./agent-team-fixture.ts";
import { messageTarget } from "./message-target.ts";
import { agentRoomKey, discordKey, groupRoomKey } from "./team-keys.ts";

const room = (name: string) => agentRoomKey("app", name);
const coordinator = {
	name: "coordinator",
	session: room("coordinator"),
	home: room("coordinator"),
};

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("a team without Discord", () => {
	useTeamFixture({ local: true });

	test("starts without a channel: the seeds live in rooms, and the configured agent coordinates", () => {
		expect(fx.channels.created).toEqual([]);
		expect(fx.store.agents().map((a) => a.channelId)).toEqual([
			undefined,
			undefined,
			undefined,
		]);
		expect(fx.team.guildId).toBe("local");
		expect(fx.team.coordinator()).toBe("coordinator");
		expect(fx.team.roomsOf("infra")).toEqual([room("infra")]);
		expect(fx.team.owns(room("infra"))).toBe("agent");
		// A key of Discord is nobody's: no agent has a channel.
		expect(fx.team.owns(discordKey(ENTRY))).toBeUndefined();
		// Characters are rendered at startup as on a host with Discord.
		expect(fx.store.agent("infra")?.character?.class).toBe("engineer");
		expect(fx.store.agent("infra")?.avatarHash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("an owner message in a room runs in the room and the reply goes to its surface", async () => {
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

	test("agent_list shows the agents without channels or a category layout", async () => {
		const list = await fx.team.list();
		expect(list).toContain('- infra "Infra" — no channel, active');
		expect(list).not.toContain("Agents:\n\nAgents");
		expect(list).not.toContain("Category");
	});

	test("channel_arrange and channel_read refuse with a text", async () => {
		await expect(
			fx.team.arrange([{ category: "Agents", names: ["infra"] }]),
		).rejects.toThrow(AgentError);
		await expect(
			fx.team.arrange([{ category: "Agents", names: ["infra"] }]),
		).rejects.toThrow("This host has no Discord channels");
		await expect(fx.team.read("<#123>", undefined, undefined)).rejects.toThrow(
			"This host has no Discord channels",
		);
	});

	test("a group is made without a channel, owns its room, and keeps its log under the room", async () => {
		const text = await fx.team.createGroup({
			name: "crew",
			displayName: "Crew",
			members: ["infra", "doctor"],
		});
		expect(text).toBe(
			'Created the group "Crew" with infra, doctor; host infra.',
		);
		expect(fx.store.group("crew")?.channelId).toBeUndefined();
		expect(fx.channels.created).toEqual([]);
		expect(fx.team.owns(groupRoomKey("app", "crew"))).toBe("group");
		expect(fx.team.roomsOf("crew")).toEqual([groupRoomKey("app", "crew")]);
		const list = await fx.team.list();
		expect(list).toContain('- crew "Crew" — no channel, active');
	});

	test("a new agent is made without a channel and starts its opening task in its room", async () => {
		fx.runtime.during = async () => {
			fx.runtime.during = undefined;
			await fx.team.create(coordinator, {
				name: "notes",
				displayName: "Notes",
				prompt: "Keep notes.",
				avatarPrompt: "A scribe.",
				task: "Say hi.",
			});
		};
		await fx.team.answerOwner(
			room("coordinator"),
			OWNER_SPEAKER,
			"go",
			"go",
			NO_ATTACHMENTS,
		);
		await settle();
		expect(fx.channels.created).toEqual([]);
		expect(fx.store.agent("notes")?.channelId).toBeUndefined();
		expect(fx.team.owns(room("notes"))).toBe("agent");
		expect(
			fx.runtime.turns.filter((t) => t.channel === room("notes")),
		).toHaveLength(1);
	});

	test("archiving clears every room of the agent, and the coordinator cannot be archived", async () => {
		await expect(fx.team.archive(coordinator, "coordinator")).rejects.toThrow(
			"The coordinator cannot be archived.",
		);
		const text = await fx.team.archive(coordinator, "doctor");
		expect(text).toBe('Archived "Doctor"; it no longer answers anywhere.');
		expect(fx.channels.webhooksRemoved).toEqual([]);
		expect(fx.team.owns(room("doctor"))).toBeUndefined();
		// Its room's schedule is cancelled and its session started over.
		expect(removedSchedules).toEqual([8]);
		expect(fx.runtime.fresh).toContain(room("doctor"));
	});

	test("a group without a channel archives, clearing its rooms' seats", async () => {
		await fx.team.createGroup({
			name: "crew",
			displayName: "Crew",
			members: ["infra", "doctor"],
		});
		await fx.team.archive(coordinator, "crew");
		expect(fx.store.group("crew")?.status).toBe("archived");
		expect(fx.team.owns(groupRoomKey("app", "crew"))).toBeUndefined();
		expect(fx.runtime.fresh).toContain("agentgroup:app.group.crew.infra");
		expect(fx.runtime.fresh).toContain("agentgroup:app.group.crew.doctor");
	});

	test("an agent's conversation, for schedule_list, is its room, and an agent with none is refused", () => {
		expect(fx.team.channelOf("infra", room("doctor"))).toBe(room("infra"));
		// Asked from nowhere in particular, the first room serves.
		expect(fx.team.channelOf("infra")).toBe(room("infra"));
		expect(() => fx.team.channelOf("nobody", room("doctor"))).toThrow(
			ScheduleError,
		);
		fx.surfaces.rooms = [];
		expect(() => fx.team.channelOf("infra")).toThrow(ScheduleError);
	});

	test("the dashboard status counts the schedules of the rooms", async () => {
		const status = await fx.team.status();
		const doctor = status.agents.find((a) => a.name === "doctor");
		// Its room holds one schedule; it has no Discord channel to hold any.
		expect(doctor?.schedules).toBe(1);
		expect(doctor?.channelId).toBeUndefined();
		expect(status.agents.find((a) => a.name === "infra")?.schedules).toBe(0);
		await fx.team.createGroup({
			name: "crew",
			displayName: "Crew",
			members: ["infra", "doctor"],
		});
		const crew = (await fx.team.status()).groups.find((g) => g.name === "crew");
		expect(crew).toMatchObject({ name: "crew", busy: 0 });
		expect(crew?.channelId).toBeUndefined();
	});

	test("the context use shown is the room conversation's", async () => {
		fx.runtime.usage.set(room("infra"), { tokens: 5, contextWindow: 100 });
		const status = await fx.team.status();
		expect(status.agents.find((a) => a.name === "infra")?.context).toEqual({
			tokens: 5,
			contextWindow: 100,
		});
	});
});

describeDb("schedule_list across the rooms of a team with Discord", () => {
	useTeamFixture();

	test("an agent asked from a room is read in its room, and from Discord in its channel", () => {
		fx.surfaces.rooms = ["app"];
		expect(fx.team.channelOf("doctor", room("infra"))).toBe(room("doctor"));
		expect(fx.team.channelOf("doctor", discordKey("2000"))).toBe(
			discordKey(fx.store.agent("doctor")?.channelId ?? ""),
		);
		expect(fx.team.channelOf("doctor")).toBe(
			discordKey(fx.store.agent("doctor")?.channelId ?? ""),
		);
		// A surface that hosts no rooms is not asked for one.
		expect(fx.team.channelOf("doctor", "other:thing")).toBe(
			discordKey(fx.store.agent("doctor")?.channelId ?? ""),
		);
	});

	test("the dashboard counts an agent's schedules across its channel and its rooms", async () => {
		fx.surfaces.rooms = ["app"];
		const doctor = (await fx.team.status()).agents.find(
			(a) => a.name === "doctor",
		);
		// Its Discord channel holds one schedule and its room another.
		expect(doctor?.schedules).toBe(2);
	});

	test("after a restart the target's latest conversation is kept, and a message stays on the sender's surface", async () => {
		fx.surfaces.rooms = ["app"];
		await fx.team.answerOwner(
			room("infra"),
			OWNER_SPEAKER,
			"hi",
			"hi",
			NO_ATTACHMENTS,
		);
		await settle();
		// The host restarts: a store over the same database knows nothing but what was kept.
		const restarted = await openTestStore(PgAgentStore, TEST_GUILD);
		try {
			expect(restarted.conversations.latest("infra")).toBe(room("infra"));
			const infra = restarted.activeAgent("infra");
			const target = (from: string) =>
				messageTarget(
					{
						store: restarted,
						roomSurfaces: ["app"],
						latest: restarted.conversations.latest("infra"),
						from,
					},
					infra,
					undefined,
				);
			// From Discord it stays on Discord, though the target last worked in its web room.
			expect(
				target(discordKey(restarted.activeAgent("doctor").channelId ?? "")),
			).toBe(discordKey(infra.channelId ?? ""));
			// From a web room it reaches the target's web room.
			expect(target(room("doctor"))).toBe(room("infra"));
			// An agent that has run nothing yet has no latest: the sender's surface decides.
			expect(restarted.conversations.latest("doctor")).toBeUndefined();
		} finally {
			await restarted.close();
		}
	});
});
