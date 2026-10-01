import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InboundMessage } from "../domain/conversation.ts";
import type { OwnerIdentity } from "../identity.ts";
import { withReference } from "../routing/message-text.ts";
import {
	answerText,
	askUserExtension,
} from "../runtime/extensions/ask-user.ts";
import {
	ConfirmationGate,
	confirmedTurnText,
} from "../runtime/extensions/confirmation-gate.ts";
import { PromptSlot } from "../runtime/prompt-slot.ts";
import { addressee, type Speaker, THE_SPEAKER } from "../speakers.ts";
import {
	agentFailureText,
	agentMessageText,
	agentReplyText,
	agentSystemPrompt,
	chainLimitReason,
	openingTaskText,
} from "./agent-prompt.ts";
import type { Agent } from "./agent-store.ts";

const ALICE: OwnerIdentity = {
	name: "Alice",
	pronouns: { subject: "she", object: "her", possessive: "her" },
};

const agent: Agent = {
	name: "scout",
	displayName: "Scout",
	prompt: "Scout things.",
	avatarPrompt: "",
	channelId: "5",
	status: "active",
};
const coordinator: Agent = {
	...agent,
	name: "coordinator",
	displayName: "Coordinator",
	channelId: "1",
};

/** Every text these modules show a model, built for an owner who is not the test default. */
function texts(): string[] {
	const gate = new ConfirmationGate(() => "delete the task", ALICE);
	gate.beginTurn("general", false);
	return [
		agentSystemPrompt({
			agent,
			coordinator,
			shared: "",
			workDir: "/w",
			owner: ALICE,
			shellUser: "alice-bot",
		}),
		agentSystemPrompt({
			agent: coordinator,
			coordinator,
			shared: "",
			workDir: "/w",
			owner: ALICE,
			shellUser: "alice-bot",
		}),
		agentMessageText(agent, "x", ALICE),
		agentReplyText(ALICE, agent, "x"),
		agentFailureText(ALICE, agent, "r"),
		openingTaskText(undefined, "t", ALICE),
		chainLimitReason(ALICE),
		answerText(undefined, ALICE),
		answerText({ choices: ["A"], text: "b" }, ALICE),
		gate.hold("any", {}) ?? "",
		confirmedTurnText(
			{ selectionId: "general", heldAt: new Date(0), calls: [] },
			"ok",
			ALICE,
		),
		withReference(
			{
				text: "look",
				forwarded: { source: "discord:2", url: "https://x", text: "f" },
			} as Pick<InboundMessage, "text" | "forwarded"> as InboundMessage,
			ALICE,
		),
	];
}

test("prompts name the configured owner and shell user, never the default's", () => {
	const all = texts().join("\n");
	expect(all).not.toContain("Riley");
	expect(all).not.toContain("mcops");
	expect(all).not.toMatch(/\b(he|him|his|He|His)\b/);
	expect(all).toContain("Alice");
	expect(all).toContain("alice-bot");
});

const BOB: Speaker = { id: "100000000000000007", name: "Bob", tier: "member" };
const promptFor = (speaker?: Speaker) =>
	agentSystemPrompt({
		agent,
		coordinator,
		shared: "",
		workDir: "/w",
		owner: ALICE,
		shellUser: "alice-bot",
		...(speaker ? { speaker } : {}),
	});

test("an owner-tier speaker gets the owner's prompts unchanged", () => {
	const owner: Speaker = { id: "1", name: "Alice", tier: "owner" };
	expect(promptFor(owner)).toBe(promptFor());
	expect(openingTaskText(undefined, "t", addressee(owner, ALICE))).toBe(
		openingTaskText(undefined, "t", ALICE),
	);
});

test("a member's turn addresses the member and says whose memory and approvals apply", () => {
	const prompt = promptFor(BOB);
	expect(prompt).toContain("only Bob approves held actions");
	expect(prompt).toContain("held for Bob's confirmation");
	expect(prompt).toContain(
		"You are talking with Bob (Discord user 100000000000000007), who speaks at the member tier",
	);
	expect(prompt).toContain("Your memory is Bob's own, not Alice's");
	expect(prompt).not.toContain("only Alice approves");
	const bob = addressee(BOB, ALICE);
	expect(chainLimitReason(bob)).toContain("without Bob in between");
	expect(agentMessageText(agent, "x", bob)).toContain("not from Bob");
	expect(gateHold(bob)).toContain("Held for Bob's confirmation");
	expect(answerText(undefined, bob)).toContain("Bob did not answer");
});

function gateHold(who: OwnerIdentity): string {
	const gate = new ConfirmationGate(() => "delete the task", ALICE);
	gate.beginTurn("general", false, who);
	return gate.hold("any", {}) ?? "";
}

test("a tool description in a shared session names the speaker, not the owner", () => {
	let description = "";
	askUserExtension(
		new PromptSlot(),
		THE_SPEAKER,
	)({
		registerTool: (tool: { description: string }) => {
			description = tool.description;
		},
	} as unknown as ExtensionAPI);
	expect(description).toContain("Ask the speaker a question");
	expect(description).toContain("wait for the speaker's answer");
	expect(description).toContain("The speaker has 30 minutes");
	expect(description).not.toContain("Alice");
});

test("a speaker who is not the owner gets the guest's shared prompt, the owner the owner's", () => {
	const prompt = (speaker?: Speaker) =>
		agentSystemPrompt({
			agent,
			coordinator,
			shared: "For the owner.",
			guestShared: "For guests.",
			workDir: "/w",
			owner: ALICE,
			shellUser: "alice-bot",
			...(speaker ? { speaker } : {}),
		});
	expect(prompt().startsWith("For the owner.")).toBe(true);
	expect(prompt({ id: "1", name: "Alice", tier: "owner" })).toBe(prompt());
	expect(prompt(BOB).startsWith("For guests.")).toBe(true);
	expect(prompt(BOB)).not.toContain("For the owner.");
});
