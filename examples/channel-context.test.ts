import { expect, test } from "bun:test";
import type { ChatSurface, InboundMessage } from "pi-roundtable";
import type { ChannelContext } from "pi-roundtable/discord";
import { fakeDiscord, testPlugin } from "pi-roundtable/testing";
import { tavern } from "./channel-context.ts";
import { createEchoRuntime } from "./echo-runtime.ts";

const AROUND: ChannelContext = {
	messages: [
		{
			id: "40",
			authorId: "7",
			authorName: "Kai",
			bot: false,
			owner: false,
			text: "I open the cellar door",
			at: new Date(0),
		},
	],
	text: '## Channel messages since your last answer\n<channel-context>\n<message from="Kai" id="7" role="member">I open the cellar door</message>\n</channel-context>',
};

/** A server message from the owner in the tavern's channel. */
function addressed(extra: Partial<InboundMessage> = {}): InboundMessage {
	return {
		channel: "discord:500",
		messageId: "50",
		authorId: "owner",
		authorName: "Ada",
		authorIsBot: false,
		isDirect: false,
		space: "9",
		mentionsBot: true,
		repliesToBot: false,
		text: "What do we find?",
		attachments: [],
		...extra,
	};
}

async function serving() {
	const asked: { message: InboundMessage; keep?: number }[] = [];
	const replies: string[] = [];
	// The Discord surface as far as the turn's reply goes: `context.turns` posts through it.
	const surface: ChatSurface = {
		surface: "discord",
		start: async () => undefined,
		sendReply: async (_channel, reply) => {
			replies.push(reply.chunks.join(""));
		},
	};
	const harness = await testPlugin(tavern(["500"]), {
		surfaces: [surface],
		providers: { runtime: createEchoRuntime },
		services: [
			fakeDiscord({
				channelContext: async (message, options) => {
					asked.push({
						message,
						...(options?.keep ? { keep: options.keep } : {}),
					});
					return AROUND;
				},
			}).service,
		],
	});
	return { asked, replies, harness };
}

test("an addressed message's turn carries the channel context after its text", async () => {
	const { asked, replies, harness } = await serving();
	await harness.conversations.handle(addressed());
	expect(asked).toEqual([
		{ message: expect.objectContaining({ messageId: "50" }), keep: 20 },
	]);
	expect(replies).toEqual([
		`[You keep the tavern's table. Answer the person who addressed you.] What do we find?\n\n${AROUND.text}`,
	]);
	await harness.stop();
});

test("a message that does not address the assistant gets no turn and reads nothing", async () => {
	const { asked, replies, harness } = await serving();
	await harness.conversations.handle(addressed({ mentionsBot: false }));
	expect(asked).toEqual([]);
	expect(replies).toEqual([]);
	await harness.stop();
});
