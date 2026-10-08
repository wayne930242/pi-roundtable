import { describe, expect, test } from "bun:test";
import type { Interaction } from "discord.js";
import type { Agent } from "../agents/agent-store.ts";
import { silentLogger } from "../log.ts";
import type { AgentServer } from "../services.ts";
import { mapIdentity } from "../testing/map-identity.ts";
import { agentPanel } from "./agent-panel.ts";
import { commandGuard } from "./owner-command.ts";

const OWNER = "1";
const agent: Agent = {
	name: "scout",
	displayName: "Scout",
	prompt: "You scout.",
	avatarPrompt: "a fox",
	channelId: "10",
	status: "active",
};
const agents = {
	directory: {
		agentByChannel: (channel: string) => (channel === "10" ? agent : undefined),
		groupByChannel: () => undefined,
		agent: (name: string) => (name === "scout" ? agent : undefined),
	},
	team: { modelOf: () => ({ model: "a/b", thinking: "auto" }) },
	avatars: { url: () => "https://x/a.png", canDraw: true },
} as unknown as AgentServer;

const SECOND_OWNER = "6";
const MEMBER = "3";

const panel = (identity?: ReturnType<typeof mapIdentity>) =>
	agentPanel({
		guard: commandGuard({
			ownerId: OWNER,
			...(identity ? { identity } : {}),
			root: "bot",
			logger: silentLogger(),
		}),
		agents,
	});

/** A press of a button or a form, recording how it was answered. */
function interaction(kind: "button" | "modal", user: string, customId: string) {
	const log: string[] = [];
	const value = {
		isButton: () => kind === "button",
		isModalSubmit: () => kind === "modal",
		customId,
		user: { id: user },
		isRepliable: () => true,
		deferred: false,
		replied: false,
		deferReply: async () => void log.push("defer"),
		editReply: async () => void log.push("edit"),
		reply: async () => void log.push("reply"),
		showModal: async () => void log.push("form"),
	} as unknown as Interaction;
	return { value, log };
}

describe("agentPanel", () => {
	test("opens the panel of the agent whose channel it is, with the custom ids posted panels already carry", () => {
		const json = JSON.stringify(panel().open("10").components[0]?.toJSON());
		for (const action of ["edit", "redraw", "newprompt", "editavatar", "model"])
			expect(json).toContain(`"roundtable:agent:${action}:scout"`);
	});

	test("refuses a channel that belongs to no agent, with a message the guard shows the owner", () => {
		expect(() => panel().open("99")).toThrow("This channel has no agent");
	});

	test("answers its buttons for the owner only, and opens the form", async () => {
		const owner = interaction("button", OWNER, "roundtable:agent:edit:scout");
		expect(await panel().handles(owner.value)).toBe(true);
		expect(owner.log).toEqual(["form"]);
		const stranger = interaction("button", "2", "roundtable:agent:edit:scout");
		expect(await panel().handles(stranger.value)).toBe(true);
		expect(stranger.log).toEqual([]);
	});

	test("answers a second owner's buttons and forms too, and a member's with nothing", async () => {
		const identity = mapIdentity({
			owners: [OWNER, SECOND_OWNER],
			members: { users: [MEMBER] },
		});
		const second = interaction(
			"button",
			SECOND_OWNER,
			"roundtable:agent:edit:scout",
		);
		expect(await panel(identity).handles(second.value)).toBe(true);
		expect(second.log).toEqual(["form"]);
		const submitted = interaction(
			"modal",
			SECOND_OWNER,
			"roundtable:agent-modal:nothing:missing",
		);
		expect(await panel(identity).handles(submitted.value)).toBe(true);
		expect(submitted.log[0]).toBe("defer");
		const member = interaction("button", MEMBER, "roundtable:agent:edit:scout");
		expect(await panel(identity).handles(member.value)).toBe(true);
		expect(member.log).toEqual([]);
	});

	test("defers a submitted form before it works, and answers a stranger with nothing", async () => {
		const owner = interaction(
			"modal",
			OWNER,
			"roundtable:agent-modal:nothing:missing",
		);
		expect(await panel().handles(owner.value)).toBe(true);
		expect(owner.log[0]).toBe("defer");
		const stranger = interaction(
			"modal",
			"2",
			"roundtable:agent-modal:edit:scout",
		);
		expect(await panel().handles(stranger.value)).toBe(true);
		expect(stranger.log).toEqual([]);
	});

	test("leaves other buttons and forms to the modules that own them", async () => {
		for (const [kind, id] of [
			["button", "roundtable:card:x"],
			["modal", "somebody:else"],
		] as const) {
			const other = interaction(kind, OWNER, id);
			expect(await panel().handles(other.value)).toBe(false);
			expect(other.log).toEqual([]);
		}
	});
});
