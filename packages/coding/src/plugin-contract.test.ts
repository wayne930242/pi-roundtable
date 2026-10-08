import { expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	IDENTITY,
	PluginError,
	type SessionContext,
	type SessionConversation,
	SKILLS,
	THE_SPEAKER,
	type Tier,
	ToolRefusal,
} from "pi-roundtable";
import { servicePair, testPlugin } from "pi-roundtable/testing";
import { coding } from "./coding-plugin.ts";

function session(
	kind: string,
	conversation: SessionConversation = { visibility: "shared" },
): SessionContext {
	return {
		kind,
		homeChannel: "test:room",
		turnChannel: "test:room",
		compaction: { wrap: (factory) => factory },
		conversation,
		addressee: THE_SPEAKER,
		memory: "speaker",
		speaker: () => undefined,
		runTask: async () => "",
	};
}

test("configuration errors are plugin errors and single-character model IDs are valid", () => {
	expect(() => coding({ shelfDir: "", model: "a/b" })).toThrow(PluginError);
	expect(() => coding({ shelfDir: "/tmp/unused-shelf", model: "bad" })).toThrow(
		PluginError,
	);
	expect(coding({ shelfDir: "/tmp/unused-shelf", model: "a/b" }).name).toBe(
		"coding",
	);
});

const privateTo = (principalId: string): SessionConversation => ({
	visibility: "private",
	principalId,
});

/** The tools a session's skill-list contribution registers, with principals' lasting tiers as given. */
async function skillListTools(
	context: SessionContext,
	tiers: ((principalId: string) => Promise<Tier | undefined>) | undefined,
): Promise<string[] | null> {
	const harness = await testPlugin(
		coding({ shelfDir: "/tmp/unused-shelf", model: "a/b" }),
		{
			services: [
				servicePair(SKILLS, { list: () => "Skills" }),
				...(tiers === undefined
					? []
					: [servicePair(IDENTITY, { tierOf: async (id) => tiers(id) })]),
			],
		},
	);
	try {
		const factory = harness.contribution.sessionTools
			?.find((item) => item.name === "coding-owner-skill-list")
			?.snapshot()
			.factory(context);
		if (!factory) return null;
		const names: string[] = [];
		// SAFETY: the skill-list extension only registers tools.
		const pi = {
			registerTool: (tool: { name: string }) => names.push(tool.name),
		} as unknown as ExtensionAPI;
		await factory(pi);
		return names;
	} finally {
		await harness.stop();
	}
}

/** Keep the same registered tool while identity or the session's scope changes. */
async function reusedSkillList() {
	let tier: Tier | undefined = "owner";
	let lookupError = false;
	let reads = 0;
	const lookups: string[] = [];
	const context = session("study", privateTo("bea"));
	const harness = await testPlugin(
		coding({ shelfDir: "/tmp/unused-shelf", model: "a/b" }),
		{
			services: [
				servicePair(SKILLS, {
					list: () => {
						reads++;
						return "Private skills";
					},
				}),
				servicePair(IDENTITY, {
					tierOf: async (id) => {
						lookups.push(id);
						if (lookupError) throw new Error("database down");
						return tier;
					},
				}),
			],
		},
	);
	try {
		const factory = harness.contribution.sessionTools?.[0]
			?.snapshot()
			.factory(context);
		if (!factory) throw new Error("missing skill-list factory");
		let tool: Pick<ToolDefinition, "execute"> | undefined;
		await factory({
			registerTool: (registered) => {
				tool = registered;
			},
		} as ExtensionAPI);
		if (!tool) throw new Error("missing skill_list");
		const registered = tool;
		return {
			context,
			lookups,
			reads: () => reads,
			demote: () => {
				tier = "member";
			},
			failLookup: () => {
				lookupError = true;
			},
			execute: () =>
				registered.execute(
					"call",
					{},
					undefined,
					undefined,
					{} as ExtensionToolContext,
				),
			stop: () => harness.stop(),
		};
	} catch (error) {
		await harness.stop();
		throw error;
	}
}

const roles = async (principalId: string): Promise<Tier | undefined> =>
	({ ada: "owner", bea: "owner", kai: "member" })[principalId] as
		| Tier
		| undefined;

test("the extra skill list is for a private conversation whose person holds the owner role, whatever its kind", async () => {
	expect(
		await skillListTools(session("owner", privateTo("ada")), roles),
	).toEqual(["skill_list"]);
	// A second owner's own conversation, of a persona other than "owner", is still an owner's.
	expect(
		await skillListTools(session("study", privateTo("bea")), roles),
	).toEqual(["skill_list"]);
});

test("no extra skill list in a member's private conversation, an owner's shared one, or an agent's", async () => {
	for (const context of [
		session("owner", privateTo("kai")),
		session("owner", privateTo("unknown")),
		session("owner"),
		session("study"),
		session("agent"),
	])
		expect((await skillListTools(context, roles)) ?? []).toEqual([]);
});

test("the same skill-list session rechecks an owner's role on every execution", async () => {
	const tool = await reusedSkillList();
	try {
		for (let i = 0; i < 2; i++)
			expect((await tool.execute()).content).toEqual([
				{ type: "text", text: "Private skills" },
			]);
		expect(tool.lookups).toEqual(["bea", "bea", "bea"]);
		expect(tool.reads()).toBe(2);
	} finally {
		await tool.stop();
	}
});

for (const change of ["demotion", "lookup error", "shared scope"] as const)
	test(`the same skill-list session refuses after ${change}`, async () => {
		const tool = await reusedSkillList();
		try {
			await tool.execute();
			if (change === "demotion") tool.demote();
			else if (change === "lookup error") tool.failLookup();
			else tool.context.conversation = { visibility: "shared" };
			await expect(tool.execute()).rejects.toBeInstanceOf(ToolRefusal);
			expect(tool.reads()).toBe(1);
		} finally {
			await tool.stop();
		}
	});

test("the extra skill list fails closed when whom the conversation serves cannot be told", async () => {
	// No identity service: no one is known to hold a role.
	expect(
		(await skillListTools(session("owner", privateTo("ada")), undefined)) ?? [],
	).toEqual([]);
	// The lookup fails.
	expect(
		(await skillListTools(session("owner", privateTo("ada")), async () => {
			throw new Error("database down");
		})) ?? [],
	).toEqual([]);
});
