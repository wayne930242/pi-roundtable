import { describe, expect, test } from "bun:test";
import { discordKey } from "../contract/discord-key.ts";
import { NO_ATTACHMENTS } from "../domain/attachment.ts";
import type { AgentTeam } from "../plugin-api/services.ts";
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
				...(category ? { hints: { category } } : {}),
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
						...(category ? { hints: { category } } : {}),
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

	describe("agent_list", () => {
		test("shows the team categories in server order, from Discord's layout", async () => {
			await fx.team.createGroup({
				name: "pair",
				displayName: "Pair",
				members: ["infra", "doctor"],
			});
			fx.channels.categories.unshift({
				id: "8000",
				name: "Notes room",
				channelIds: ["8001"],
			});
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
});
