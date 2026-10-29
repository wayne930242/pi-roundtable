import { expect, test } from "bun:test";
import type {
	ChannelContext,
	ChannelContexts,
} from "../contract/channel-context.ts";
import type { InboundMessage } from "../contract/channels.ts";
import type { ChatSurface } from "../contract/surface.ts";
import {
	ChannelContextReader,
	type ContextSourceMessage,
} from "../discord/channel-context.ts";
import { DiscordSurface } from "../discord/discord-surface.ts";
import { silentLogger } from "../log.ts";
import type { PluginContext } from "../plugin.ts";
import { surfacePort } from "../routing/surface-port.ts";
import { CHANNEL_CONTEXT } from "../services.ts";
import { channelContextPlugin } from "./channel-context.ts";

const OWNER = "100";

let clock = 1_000;
function fetched(id: string, text: string): ContextSourceMessage {
	clock += 1_000;
	return {
		id,
		authorId: "200",
		authorName: "Kai",
		bot: false,
		own: false,
		at: clock,
		text,
	};
}

function inbound(extra: Partial<InboundMessage> = {}): InboundMessage {
	return {
		channel: "discord:77",
		messageId: "50",
		authorId: OWNER,
		authorName: "Ada",
		authorIsBot: false,
		isDirect: false,
		space: "g1",
		mentionsBot: true,
		repliesToBot: false,
		text: "what do you think?",
		attachments: [],
		...extra,
	};
}

/** The channel's history, shared by every reader of these tests. */
const HISTORY = [fetched("10", "first"), fetched("11", "second")];

/** A Discord surface over a reader with its own memory of the history, as the Discord plugin builds it. */
function discordSurface(): DiscordSurface {
	const reader = new ChannelContextReader({
		read: async () => HISTORY,
		owners: async () => [OWNER],
		settings: {},
		logger: silentLogger(),
	});
	return new DiscordSurface({
		token: "token",
		ownerId: OWNER,
		ownerName: "Ada",
		prompts: () => undefined,
		logger: silentLogger(),
		channelContext: (message, options) => reader.of(message, options),
	});
}

/** The plugin set up over these surfaces; returns the service it provides. */
async function service(
	surfaces: readonly ChatSurface[],
): Promise<ChannelContexts> {
	let provided: ChannelContexts | undefined;
	await channelContextPlugin().setup({
		surfaces: surfacePort(() => surfaces),
		services: {
			provide: (key: { id: string }, value: ChannelContexts) => {
				if (key.id === CHANNEL_CONTEXT.id) provided = value;
			},
		},
	} as unknown as PluginContext);
	if (!provided) throw new Error("the plugin provided no CHANNEL_CONTEXT");
	return provided;
}

/** A surface of another network that reads its own channel. */
function inboxSurface(read: ChatSurface["channelContext"]): ChatSurface {
	return {
		surface: "inbox",
		start: async () => undefined,
		sendReply: async () => undefined,
		...(read ? { channelContext: read } : {}),
	};
}

test("CHANNEL_CONTEXT reads a Discord message as the Discord surface does", async () => {
	const viaService = await (await service([discordSurface()])).read(inbound());
	const direct = await discordSurface().channelContext(inbound());
	expect(viaService?.messages.map((m) => m.id)).toEqual(["10", "11"]);
	expect(viaService).toEqual(direct as ChannelContext);
});

test("a surface without the method, a channel no surface serves and a key without a surface give no context", async () => {
	const reads = await service([discordSurface(), inboxSurface(undefined)]);
	expect(
		await reads.read(inbound({ channel: "inbox:thread-1" })),
	).toBeUndefined();
	expect(await reads.read(inbound({ channel: "other:1" }))).toBeUndefined();
	expect(
		await reads.read(
			inbound({ channel: "nocolon" as InboundMessage["channel"] }),
		),
	).toBeUndefined();
});

test("the surface is chosen by the channel key, and the options reach it", async () => {
	const seen: unknown[] = [];
	const reads = await service([
		discordSurface(),
		inboxSurface(async (message, options) => {
			seen.push([message.channel, options]);
			return {
				messages: [
					{
						id: "m1",
						authorId: "a@example.com",
						authorName: "Customer",
						bot: false,
						owner: false,
						external: true,
						text: "Where is my order?",
						at: new Date(0),
					},
				],
				text: "block",
			};
		}),
	]);
	const got = await reads.read(inbound({ channel: "inbox:thread-1" }), {
		keep: 3,
	});
	expect(seen).toEqual([["inbox:thread-1", { keep: 3 }]]);
	expect(got?.messages[0]?.external).toBe(true);
});
