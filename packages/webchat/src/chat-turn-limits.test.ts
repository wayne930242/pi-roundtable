import { expect, test } from "bun:test";
import { gated } from "./testing/chat-fixture.ts";
import { speakerOf } from "./testing/fakes.ts";

test("a person runs at most turnsPerPrincipal turns at once across conversations; one more is refused busy", async () => {
	const { connect, say, turns, finish, errors, accepted, chat } = await gated({
		turnsPerPrincipal: 2,
		unusedConversationsPerPrincipal: 4,
	});
	const ada = connect("ada");
	await say(ada, { type: "send", id: "1", persona: "helper", text: "one" });
	await say(ada, { type: "send", id: "2", persona: "helper", text: "two" });
	const opened = chat.open(speakerOf("ada"), "helper");
	await say(ada, { type: "send", id: "3", persona: "helper", text: "three" });
	await say(ada, {
		type: "send",
		id: "4",
		conversation: opened,
		text: "four",
	});
	expect(errors(ada)).toEqual([
		{ type: "error", code: "busy", ref: "3" },
		{ type: "error", code: "busy", ref: "4" },
	]);
	expect(accepted(ada)).toHaveLength(2);
	expect(turns).toHaveLength(2);
	// A refused message to a persona opens no conversation: room is left for a fourth.
	chat.open(speakerOf("ada"), "helper");
	expect(() => chat.open(speakerOf("ada"), "helper")).toThrow(
		"too_many_conversations",
	);
	// Someone else is not held back by ada's turns.
	const eve = connect("eve");
	await say(eve, { type: "send", id: "e", persona: "helper", text: "hi" });
	expect(errors(eve)).toEqual([]);
	await finish();
	await say(ada, {
		type: "send",
		id: "5",
		conversation: opened,
		text: "five",
	});
	expect(errors(ada)).toHaveLength(2);
	expect(turns).toHaveLength(4);
	await finish();
});

test("a conversation holds one running turn and at most one queued behind it", async () => {
	const { connect, say, turns, finish, errors, accepted } = await gated({
		turnsPerPrincipal: 5,
	});
	const ada = connect("ada");
	await say(ada, { type: "send", id: "1", persona: "helper", text: "one" });
	const [first] = accepted(ada);
	const conversation = first?.conversation ?? "";
	await say(ada, { type: "send", id: "2", conversation, text: "two" });
	await say(ada, { type: "send", id: "3", conversation, text: "three" });
	expect(errors(ada)).toEqual([{ type: "error", code: "busy", ref: "3" }]);
	expect(turns).toHaveLength(2);
	await finish();
	await say(ada, { type: "send", id: "4", conversation, text: "four" });
	expect(errors(ada)).toHaveLength(1);
	await finish();
});

test("a failed turn, a dropped message, and a refused delivery free their place", async () => {
	const failing = await gated({ turnsPerPrincipal: 1 }, { fail: true });
	const ada = failing.connect("ada");
	await failing.say(ada, {
		type: "send",
		id: "1",
		persona: "helper",
		text: "a",
	});
	await failing.finish();
	await failing.say(ada, {
		type: "send",
		id: "2",
		persona: "helper",
		text: "b",
	});
	expect(failing.errors(ada)).toEqual([]);
	await failing.finish();

	const unstarted = await gated({ turnsPerPrincipal: 1 }, { start: false });
	const eve = unstarted.connect("eve");
	await expect(
		unstarted.say(eve, { type: "send", id: "1", persona: "helper", text: "a" }),
	).rejects.toThrow("has not started");
	await unstarted.start();
	await unstarted.say(eve, {
		type: "send",
		id: "2",
		persona: "helper",
		text: "b",
	});
	expect(unstarted.errors(eve)).toEqual([]);
	await unstarted.finish();

	const dropping = await gated({ turnsPerPrincipal: 1 }, { start: false });
	const claim = dropping.chat.claim();
	await dropping.chat.surface.start((message) => {
		// Another author's message: the claim drops it.
		claim.admit({ ...message, authorId: "someone-else" });
	});
	const bob = dropping.connect("bob");
	await dropping.say(bob, {
		type: "send",
		id: "1",
		persona: "helper",
		text: "a",
	});
	await dropping.say(bob, {
		type: "send",
		id: "2",
		persona: "helper",
		text: "b",
	});
	expect(dropping.errors(bob)).toEqual([]);

	// Admitted, then dropped by the router, whose record found the author someone else meanwhile.
	const routed = await gated({ turnsPerPrincipal: 1 }, { start: false });
	const routedClaim = routed.chat.claim();
	await routed.chat.surface.start((message) => {
		const admission = routedClaim.admit({
			...message,
			speaker: speakerOf(message.authorId),
		});
		if (admission?.kind === "turn") admission.dropped?.();
	});
	const cy = routed.connect("cy");
	for (const id of ["1", "2"])
		await routed.say(cy, { type: "send", id, persona: "helper", text: "a" });
	expect(routed.errors(cy)).toEqual([]);
});

test("a message the router drops after it was accepted tells its person it failed", async () => {
	const routed = await gated({}, { start: false });
	const claim = routed.chat.claim();
	await routed.chat.surface.start((message) => {
		const admission = claim.admit({
			...message,
			speaker: speakerOf(message.authorId),
		});
		if (admission?.kind === "turn") admission.dropped?.();
	});
	const cy = routed.connect("cy");
	await routed.say(cy, { type: "send", id: "1", persona: "helper", text: "a" });
	const [accepted] = routed.accepted(cy);
	if (!accepted) throw new Error("the message was not accepted");
	expect(cy.frames.filter((f) => f.type === "failed")).toEqual([
		{ type: "failed", conversation: accepted.conversation, stopped: false },
	]);
	expect(routed.turns).toEqual([]);
});
