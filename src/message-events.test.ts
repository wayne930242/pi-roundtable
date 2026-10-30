import { expect, test } from "bun:test";
import type { InboundMessage } from "./core/contract/channels.ts";
import type { SurfaceMessageEvents } from "./core/contract/surface.ts";
import type { RoundtablePlugin } from "./core/plugin.ts";
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
