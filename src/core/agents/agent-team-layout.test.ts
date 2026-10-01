import { beforeEach, describe, expect, test } from "bun:test";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { AgentTeam } from "../services.ts";
import { describeDb } from "../testing/database.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import {
	agentChannel,
	duringTurn,
	ENTRY,
	fx,
	settle,
	useTeamFixture,
} from "./agent-team-fixture.ts";
import { discordKey } from "./team-keys.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	useTeamFixture();

	describe("categories", () => {
		const channelOf = (name: string) =>
			fx.store.agent(name)?.channelId ?? fx.store.group(name)?.channelId ?? "";
		const pair = (category?: string) =>
			fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
				...(category ? { category } : {}),
			});
		const newAgent = (category?: string) =>
			duringTurn(() =>
				fx.team.create(
					{
						name: "coordinator",
						session: discordKey(ENTRY),
						home: discordKey(ENTRY),
					},
					{
						name: "notes",
						displayName: "Notes",
						prompt: "Keep notes.",
						avatarPrompt: "A scribe.",
						task: "Say hi.",
						...(category ? { category } : {}),
					},
				),
			);

		test("agent channels open under Agents and group channels under Groups", async () => {
			await pair();
			expect(fx.channels.categoryOf(channelOf("doctor"))).toBe("Agents");
			expect(fx.channels.categoryOf(channelOf("pair"))).toBe("Groups");
		});

		test("a new agent or group opens under the suffixed category it names", async () => {
			await newAgent("Agents-Life");
			await pair("Groups-Work");
			await settle();
			expect(fx.channels.categoryOf(channelOf("notes"))).toBe("Agents-Life");
			expect(fx.channels.categoryOf(channelOf("pair"))).toBe("Groups-Work");
		});

		test("a category of the other kind or an invalid name is refused before anything is made", async () => {
			await expect(newAgent("Groups-Work")).rejects.toThrow(/Agents-<suffix>/);
			await expect(newAgent("Agents-")).rejects.toThrow(/not a team category/);
			await expect(pair("Agents")).rejects.toThrow(/Groups-<suffix>/);
			await expect(newAgent(`Agents-${"x".repeat(33)}`)).rejects.toThrow(
				/not a team category/,
			);
			expect(fx.channels.created).toEqual(["doctor", "infra"]);
		});

		test("startup moves a group channel outside every Groups category into Groups", async () => {
			await pair();
			const id = channelOf("pair");
			fx.channels.put(id, "Agents-Work");
			await fx.team.start();
			expect(fx.channels.categoryOf(id)).toBe("Groups");
		});

		test("startup leaves a group channel under a suffixed Groups category", async () => {
			await pair();
			const id = channelOf("pair");
			fx.channels.put(id, "Groups-Work");
			await fx.team.start();
			expect(fx.channels.categoryOf(id)).toBe("Groups-Work");
		});
	});

	describe("postAs", () => {
		test("posts under the caller's name in its own channel", async () => {
			const infra = agentChannel("infra");
			await fx.team.postAs(
				{ name: "infra", session: infra, home: infra },
				"📦 report",
			);
			expect(
				fx.channels.texts(fx.store.agent("infra")?.channelId ?? ""),
			).toEqual(["Infra: 📦 report"]);
		});

		test("in a group round it posts in the group channel", async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
			});
			const pair = fx.store.group("pair");
			await fx.team.postAs(
				{
					name: "doctor",
					session: discordKey("x"),
					home: agentChannel("doctor"),
					group: "pair",
				},
				"📦 report",
			);
			expect(fx.channels.texts(pair?.channelId ?? "")[0]).toBe(
				"Doctor: 📦 report",
			);
		});
	});

	describe("announce", () => {
		test("posts in the coordinator's channel under its name", async () => {
			await fx.team.announce("🔄 Updated to `abc1234`");
			expect(fx.channels.texts(ENTRY)).toEqual([
				"Coordinator: 🔄 Updated to `abc1234`",
			]);
		});
	});

	describe("channel_arrange", () => {
		const id = (name: string) =>
			fx.store.agent(name)?.channelId ?? fx.store.group(name)?.channelId ?? "";
		const shape = () =>
			fx.channels.categories.map((c) => `${c.name}: ${c.channelIds.join(",")}`);

		beforeEach(async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
			});
			// The owner's own category, and the coordinator's channel outside any category.
			fx.channels.categories.unshift({
				id: "8000",
				name: "Notes room",
				channelIds: ["8001"],
			});
		});

		test("puts the listed categories and channels first, the rest after, and deletes emptied team categories", async () => {
			const agentsId =
				fx.channels.categories.find((c) => c.name === "Agents")?.id ?? "";
			const said = await fx.team.arrange([
				{ category: "Agents-Ops", names: ["infra", "doctor"] },
				{ category: "Groups", names: ["pair"] },
				{ category: "Agents-HQ", names: ["coordinator"] },
			]);
			expect(shape()).toEqual([
				`Agents-Ops: ${id("infra")},${id("doctor")}`,
				`Groups: ${id("pair")}`,
				`Agents-HQ: ${ENTRY}`,
				"Notes room: 8001",
			]);
			expect(fx.channels.arranged[0]?.remove).toEqual([agentsId]);
			expect(said).toContain("1 empty team categories were deleted");
			expect(said).toContain("- Agents-Ops: infra, doctor");
		});

		test("keeps a listed category's other channels after the listed ones", async () => {
			fx.channels.categories
				.find((c) => c.name === "Agents")
				?.channelIds.push("8002");
			await fx.team.arrange([{ category: "Agents", names: ["infra"] }]);
			expect(shape()[0]).toBe(`Agents: ${id("infra")},${id("doctor")},8002`);
			expect(fx.channels.arranged[0]?.remove).toEqual([]);
		});

		test("refuses the whole call on any wrong entry and moves nothing", async () => {
			const before = shape();
			await expect(
				fx.team.arrange([{ category: "Groups-Work", names: ["infra"] }]),
			).rejects.toThrow(/an agent goes under Agents/);
			await expect(
				fx.team.arrange([{ category: "Agents-Work", names: ["pair"] }]),
			).rejects.toThrow(/a group goes under Groups/);
			await expect(
				fx.team.arrange([
					{ category: "Agents-a", names: ["infra"] },
					{ category: "Agents-b", names: ["infra"] },
				]),
			).rejects.toThrow(/listed twice/);
			await expect(
				fx.team.arrange([
					{ category: "Agents", names: ["infra"] },
					{ category: "Agents", names: ["doctor"] },
				]),
			).rejects.toThrow(/listed twice/);
			await expect(
				fx.team.arrange([{ category: "Agents", names: ["nobody"] }]),
			).rejects.toThrow(/agent_list/);
			await fx.team.archive(
				{
					name: "coordinator",
					session: discordKey(ENTRY),
					home: discordKey(ENTRY),
				},
				"pair",
			);
			const archived = shape();
			await expect(
				fx.team.arrange([{ category: "Groups", names: ["pair"] }]),
			).rejects.toThrow(/archived/);
			await expect(
				fx.team.arrange([{ category: "Agents", names: [] }]),
			).rejects.toThrow(/at least one/);
			await expect(fx.team.arrange([])).rejects.toThrow(/at least one/);
			expect(fx.channels.arranged).toEqual([]);
			expect(archived).not.toEqual(before);
			expect(shape()).toEqual(archived);
		});

		test("agent_list shows the team categories in server order", async () => {
			const listed = await fx.team.list();
			expect(listed).toContain(
				`Categories, in server order:\n- Agents: doctor, infra\n- Groups: pair`,
			);
			expect(listed).not.toContain("Notes room");
		});
	});

	describe("status", () => {
		test("shows who is working where, then idle with last activity and context use", async () => {
			const doctor = discordKey(fx.store.agent("doctor")?.channelId ?? "");
			let during: Awaited<ReturnType<AgentTeam["status"]>> | undefined;
			let changes = 0;
			fx.team.onChange(() => changes++);
			fx.runtime.during = () => {
				void fx.team.status().then((status) => {
					during = status;
				});
			};
			fx.runtime.usage.set(doctor, { tokens: 42_000, contextWindow: 200_000 });
			await fx.queue.run(doctor, () =>
				fx.team.answerOwner(doctor, OWNER_SPEAKER, "hi", "hi", NO_ATTACHMENTS),
			);
			await settle();
			const busy = during?.agents.find((a) => a.name === "doctor");
			expect(busy?.workingIn).toBe(doctor.slice("discord:".length));
			expect(busy?.waiting).toBe(0);
			const after = (await fx.team.status()).agents.find(
				(a) => a.name === "doctor",
			);
			expect(after?.workingIn).toBeUndefined();
			expect(after?.lastActive).toBeInstanceOf(Date);
			expect(after?.context).toEqual({
				tokens: 42_000,
				contextWindow: 200_000,
			});
			expect(after?.schedules).toBe(1);
			expect(after?.model).toBe("claude-bridge/claude-opus-5-5");
			expect(changes).toBeGreaterThanOrEqual(2);
		});

		test("lists active groups with members and host by display name", async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
			});
			const [pair] = (await fx.team.status()).groups;
			expect(pair).toMatchObject({
				displayName: "Pair",
				members: ["Infra", "Doctor"],
				host: "Infra",
				busy: 0,
			});
		});
	});

	describe("channel_read", () => {
		test("reads a channel given as a mention, capped at 50, one line per message", async () => {
			fx.channels.history = [
				{
					id: "55",
					author: "Sam",
					at: new Date("2026-09-27T06:03:00Z"),
					text: "remember this",
					attachments: ["log.txt"],
				},
			];
			const text = await fx.team.read("<#321>", "55", 80);
			expect(fx.channels.reads).toEqual([
				{ channelId: "321", limit: 50, around: "55" },
			]);
			expect(text).toBe(
				"[55] 2026-09-27 06:03 Sam: remember this [attachments: log.txt]",
			);
		});

		test("refuses a channel that is not an id", async () => {
			await expect(
				fx.team.read("#notes", undefined, undefined),
			).rejects.toThrow(/<#id>/);
		});
	});
});
