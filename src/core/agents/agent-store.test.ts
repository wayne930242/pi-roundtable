import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { AgentError } from "../domain/errors.ts";
import {
	describeDb,
	openTestStore,
	TEST_GUILD,
	type TestStore,
	testDatabaseUrl,
} from "../testing/database.ts";
import { PgAgentStore } from "./agent-store.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	let store: TestStore<PgAgentStore>;

	const seed = (name: string, channelId?: string) => ({
		name,
		displayName: name.toUpperCase(),
		prompt: `You are ${name}.`,
		avatarPrompt: `A portrait of ${name}.`,
		...(channelId ? { channelId } : {}),
	});

	beforeEach(async () => {
		await store?.close();
		const admin = new SQL(testDatabaseUrl);
		for (const table of [
			"agents",
			"agent_groups",
			"agent_group_messages",
			"agent_group_cursors",
		])
			await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
		await admin.close();
		store = await openTestStore(PgAgentStore, TEST_GUILD);
		await store.seed([
			seed("coordinator", "100"),
			seed("infra"),
			seed("doctor"),
		]);
	});

	afterAll(async () => {
		await store.close();
	});

	describe("agents", () => {
		test("seeding never overwrites an existing agent", async () => {
			await store.updateAgent("infra", { prompt: "Edited." });
			const added = await store.seed([seed("infra"), seed("new-one")]);
			expect(added).toEqual(["new-one"]);
			expect(store.agent("infra")?.prompt).toBe("Edited.");
			const reopened = await openTestStore(PgAgentStore, TEST_GUILD);
			expect(reopened.agent("infra")?.prompt).toBe("Edited.");
			await reopened.close();
		});

		test("finds an active agent by its channel", async () => {
			expect(store.agentByChannel("100")?.name).toBe("coordinator");
			await store.archiveAgent("coordinator");
			expect(store.agentByChannel("100")).toBeUndefined();
		});

		test("display names change; names are checked and never reused", async () => {
			const agent = await store.updateAgent("infra", {
				displayName: "  Ops  ",
			});
			expect(agent.displayName).toBe("Ops");
			expect(agent.name).toBe("infra");
			await expect(
				store.updateAgent("infra", { displayName: "discord bot" }),
			).rejects.toBeInstanceOf(AgentError);
			expect(() => store.checkNewName("Bad Name")).toThrow(AgentError);
			await store.archiveAgent("doctor");
			expect(() => store.checkNewName("doctor")).toThrow(/taken/);
			expect(() => store.activeAgent("doctor")).toThrow(/archived/);
		});

		test("prompts are limited to 4,000 characters", async () => {
			await expect(
				store.updateAgent("infra", { prompt: "x".repeat(4001) }),
			).rejects.toThrow(/4000/);
		});
	});

	describe("model settings", () => {
		test("model and thinking are kept, survive a reopen, and reset with null", async () => {
			await store.updateAgent("infra", {
				model: "openai-codex/gpt-6-sol",
				thinking: "high",
			});
			const reopened = await openTestStore(PgAgentStore, TEST_GUILD);
			expect(reopened.agent("infra")).toMatchObject({
				model: "openai-codex/gpt-6-sol",
				thinking: "high",
			});
			await reopened.close();
			await store.updateAgent("infra", { prompt: "Other." });
			expect(store.agent("infra")?.model).toBe("openai-codex/gpt-6-sol");
			const reset = await store.updateAgent("infra", {
				model: null,
				thinking: null,
			});
			expect(reset.model).toBeUndefined();
			expect(reset.thinking).toBeUndefined();
		});

		test("a malformed model or unknown thinking level is refused", async () => {
			await expect(
				store.updateAgent("infra", { model: "gpt-6-sol" }),
			).rejects.toThrow(AgentError);
			await expect(
				// @ts-expect-error: an unknown level from outside the type system
				store.updateAgent("infra", { thinking: "extreme" }),
			).rejects.toThrow(/thinking level/);
		});
	});

	describe("groups", () => {
		const makeGroup = () =>
			store.createGroup({
				name: "ops",
				displayName: "Ops",
				channelId: "200",
				members: ["coordinator", "infra", "doctor"],
				host: "coordinator",
			});

		test("a group needs 2 to 6 distinct active members and a member host", async () => {
			expect(() => store.checkNewGroup("g", ["infra"], "infra")).toThrow(
				AgentError,
			);
			expect(() =>
				store.checkNewGroup("g", ["infra", "doctor"], "coordinator"),
			).toThrow(/host/);
			expect(() =>
				store.checkNewGroup("infra", ["infra", "doctor"], "infra"),
			).toThrow(/taken/);
			const group = await makeGroup();
			expect(store.groupByChannel("200")?.members).toEqual(group.members);
		});

		test("an archived agent leaves its groups, which hand over hosting or archive", async () => {
			await makeGroup();
			await store.archiveAgent("coordinator");
			const group = store.group("ops");
			expect(group?.members).toEqual(["infra", "doctor"]);
			expect(group?.host).toBe("infra");
			await store.archiveAgent("doctor");
			expect(store.group("ops")?.status).toBe("archived");
		});

		test("each message reaches each member once, its own excluded", async () => {
			await makeGroup();
			const owner = await store.appendGroupMessage("ops", {
				author: "owner",
				authorName: "Riley",
				text: "hi",
			});
			await store.appendGroupMessage("ops", {
				author: "infra",
				authorName: "INFRA",
				text: "disk ok",
			});
			const first = await store.backlog("ops", "doctor", 40);
			expect(first.messages.map((m) => m.text)).toEqual(["hi", "disk ok"]);
			await store.advanceCursor("ops", "doctor", first.lastId ?? 0);
			expect((await store.backlog("ops", "doctor", 40)).messages).toEqual([]);

			const infra = await store.backlog("ops", "infra", 40);
			expect(infra.messages.map((m) => m.id)).toEqual([owner]);
			await store.advanceCursor("ops", "infra", infra.lastId ?? 0);

			// A cursor never moves back, so a message is never delivered twice.
			await store.advanceCursor("ops", "infra", owner - 1);
			expect((await store.backlog("ops", "infra", 40)).messages).toEqual([]);
		});

		test("a long backlog carries the newest messages and counts the rest", async () => {
			await makeGroup();
			for (let i = 0; i < 5; i++)
				await store.appendGroupMessage("ops", {
					author: "owner",
					authorName: "Riley",
					text: `m${i}`,
				});
			const backlog = await store.backlog("ops", "doctor", 2);
			expect(backlog.messages.map((m) => m.text)).toEqual(["m3", "m4"]);
			expect(backlog.skipped).toBe(3);
		});

		test("catching up marks everything as received", async () => {
			const group = await makeGroup();
			await store.appendGroupMessage("ops", {
				author: "owner",
				authorName: "Riley",
				text: "old",
			});
			await store.catchUp(group);
			for (const member of group.members)
				expect((await store.backlog("ops", member, 40)).messages).toEqual([]);
		});
	});
});
