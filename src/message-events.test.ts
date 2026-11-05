import { expect, test } from "bun:test";
import type { InboundMessage } from "./core/contract/channels.ts";
import type { SurfaceMessageEvents } from "./core/contract/surface.ts";
import type { RoundtablePlugin } from "./core/plugin-api/plugin.ts";
import { testPlugin } from "./testing.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		channel: "desk:room",
		messageId: "m1",
		authorId: "100",
		authorName: "Ada",
		authorIsBot: false,
		isDirect: false,
		space: "team",
		mentionsBot: false,
		repliesToBot: false,
		text: "hello",
		attachments: [],
		...overrides,
	};
}

/** A surface of its own that keeps what the host gave it, and a claim and an observer that log. */
function desk() {
	const log: string[] = [];
	let events: SurfaceMessageEvents | undefined;
	const plugin: RoundtablePlugin = {
		name: "desk",
		setup: (context) => {
			context.observe(
				{ surface: "desk" },
				(m) => void log.push(`saw ${m.text}`),
			);
			return {
				surfaces: [
					{
						surface: "desk",
						start: async (_deliver, given) => {
							events = given;
						},
						sendReply: async () => undefined,
					},
				],
				channels: [
					{
						name: "desk",
						priority: 0,
						owns: (channel) => channel.startsWith("desk:"),
						admit: () => undefined,
						onMessageDeleted: (channel, id) =>
							void log.push(`gone ${channel} ${id}`),
						onMessageEdited: (m) => void log.push(`edited ${m.text}`),
						startFresh: async () => "desk",
					},
				],
			};
		},
	};
	return { plugin, log, events: () => events };
}

test("a surface's delete and edit events reach the owning claim, and observers hear messages", async () => {
	const { plugin, log, events } = desk();
	const harness = await testPlugin(plugin);
	await harness.conversations.handle(message());
	await tick();
	events()?.deleted("desk:room", "m1", "team");
	events()?.edited(message({ text: "hello again" }));
	await tick();
	expect(log).toEqual(["saw hello", "gone desk:room m1", "edited hello again"]);
	await harness.stop();
});

/** A surface whose claim runs a turn that waits for `release`, and logs marks, runs and drops. */
function busyDesk() {
	const log: string[] = [];
	const gate = Promise.withResolvers<void>();
	let events: SurfaceMessageEvents | undefined;
	const plugin: RoundtablePlugin = {
		name: "busy-desk",
		setup: () => ({
			surfaces: [
				{
					surface: "desk",
					start: async (_deliver, given) => {
						events = given;
					},
					sendReply: async () => undefined,
				},
			],
			channels: [
				{
					name: "desk",
					priority: 0,
					owns: (channel) => channel.startsWith("desk:"),
					admit: (m) => ({
						kind: "turn",
						busy: {
							react: async (emoji) => void log.push(`+${emoji} ${m.text}`),
							unreact: async (emoji) => void log.push(`-${emoji} ${m.text}`),
						},
						run: async () => {
							log.push(`run ${m.text}`);
							if (m.text === "first") await gate.promise;
						},
						dropped: () => void log.push(`dropped ${m.text}`),
						failure: "failed",
					}),
					startFresh: async () => "desk",
				},
			],
		}),
	};
	return { plugin, log, release: gate.resolve, events: () => events };
}

test("deleting a queued message on its surface cancels its turn, and editing it changes what the turn uses", async () => {
	const { plugin, log, release, events } = busyDesk();
	const harness = await testPlugin(plugin);
	const first = harness.conversations.handle(
		message({ messageId: "a", text: "first" }),
	);
	await tick();
	const edited = harness.conversations.handle(
		message({ messageId: "b", text: "second" }),
	);
	const deleted = harness.conversations.handle(
		message({ messageId: "c", text: "third" }),
	);
	await tick();
	events()?.edited(message({ messageId: "b", text: "second, reworded" }));
	events()?.deleted("desk:room", "c", "team");
	await tick();
	release();
	await Promise.all([first, edited, deleted]);
	expect(log).toEqual([
		"run first",
		"+⏳ second",
		"+⏳ third",
		"dropped second",
		"dropped third",
		"-⏳ second, reworded",
		"run second, reworded",
	]);
	await harness.stop();
});
