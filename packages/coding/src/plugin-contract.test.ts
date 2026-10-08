import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	IDENTITY,
	PluginError,
	type SessionContext,
	type SessionConversation,
	SKILLS,
	THE_SPEAKER,
	type Tier,
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
