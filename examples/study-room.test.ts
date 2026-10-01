import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { createEchoRuntime } from "./echo-runtime.ts";
import { FakeSurface } from "./fake-surface.ts";
import { studyRoom } from "./study-room.ts";

/** The plugin over the fake surface and the echo runtime, with nothing else: no Discord, no Pi, no database. */
async function studying() {
	const surface = new FakeSurface();
	const harness = await testPlugin(studyRoom, {
		surfaces: [surface],
		providers: { runtime: createEchoRuntime },
	});
	return { surface, harness };
}

async function until(done: () => boolean): Promise<void> {
	for (let waited = 0; !done() && waited < 1000; waited += 5)
		await Bun.sleep(5);
	expect(done()).toBe(true);
}

test("a message in a study room runs as a turn of the study kind, with the tutor's persona", async () => {
	const { surface, harness } = await studying();
	surface.say("fake:study-algebra", "What is a group?");
	await until(() => surface.replies.length > 0);
	expect(surface.replies).toEqual([
		{
			channel: "fake:study-algebra",
			reply: {
				chunks: [
					"[You are a patient tutor. Ask one question back before you give the answer.] What is a group?",
				],
			},
		},
	]);
	// The plugins' turn events carry the kind and no agent.
	const started = harness.events.find(({ name }) => name === "turnStarted");
	expect(started?.turn).toMatchObject({
		kind: "study",
		channel: "fake:study-algebra",
	});
	expect(started?.turn?.agent).toBeUndefined();
	await harness.stop();
});

test("a channel that is not a study room is not the claim's", async () => {
	const { surface, harness } = await studying();
	surface.say("fake:lounge", "hello");
	await Bun.sleep(30);
	expect(surface.replies).toEqual([]);
	await harness.stop();
});

test("starting a room over says it was a study conversation", async () => {
	const { harness } = await studying();
	expect(await harness.conversations.startFresh("fake:study-algebra")).toBe(
		"study",
	);
	await harness.stop();
});

test("the persona is the plugin's and belongs to the study kind only", async () => {
	const { harness } = await studying();
	const [persona] = harness.contribution.personas ?? [];
	expect(persona?.kind).toBe("study");
	expect(persona?.prompt()).toContain("patient tutor");
	await harness.stop();
});
