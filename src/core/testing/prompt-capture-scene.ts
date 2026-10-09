// The people, guild, and channel of the prompt capture hosts.
import type { DiscordServices } from "../builtin/discord.ts";
import {
	ChannelContextReader,
	type ContextSourceMessage,
} from "../discord/channel-context.ts";
import type { ChannelKey, InboundMessage } from "../domain/conversation.ts";
import { silentLogger } from "../log.ts";
import type { Speaker } from "../speakers.ts";

/** The owner of the capture hosts; ids scan-public lets through, kept apart from other tests' rows. */
export const CAPTURE_OWNER = {
	id: "966666600000000001",
	name: "Ada",
	pronouns: "she",
} as const;
/** The guild of the Discord capture host, so its agents are its own. */
export const CAPTURE_GUILD = "966666600000000002";
/** A member who speaks in a persona conversation. */
export const CAPTURE_MEMBER: Speaker = {
	id: "966666600000000003",
	name: "Kai",
	tier: "member",
	principalId: "966666600000000003",
};
/** A web user as M1's webchat names them. */
export const CAPTURE_WEB_MEMBER: Speaker = {
	id: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20:user-7",
	name: "Noa",
	tier: "member",
	principalId: "oidc:aHR0cHM6Ly9pZHAuZXhhbXBsZS5jb20:user-7",
};

/** Someone else in the capture guild, whose message an addressed turn reads as channel context. */
const CAPTURE_NEIGHBOUR = { id: "966666600000000005", name: "Rio" };

/**
 * What the capture guild's channels hold before an addressed message: an earlier exchange the
 * assistant answered, then what others said since, as the Discord surface reports it.
 */
const CAPTURE_CHANNEL: readonly ContextSourceMessage[] = [
	{
		id: "966666620000000001",
		authorId: CAPTURE_OWNER.id,
		authorName: CAPTURE_OWNER.name,
		bot: false,
		own: false,
		at: 1,
		text: "Which shelf holds the atlases?",
	},
	{
		id: "966666620000000002",
		authorId: "966666600000000006",
		authorName: "Librarian",
		bot: true,
		own: true,
		at: 2,
		text: "The third shelf.",
	},
	{
		id: "966666620000000003",
		authorId: CAPTURE_NEIGHBOUR.id,
		authorName: CAPTURE_NEIGHBOUR.name,
		bot: false,
		own: false,
		at: 3,
		text: "I moved the atlases to the reading room.",
	},
	{
		id: "966666620000000004",
		authorId: "966666600000000007",
		authorName: "Shelfbot",
		bot: true,
		own: false,
		at: 4,
		text: "Reading room: 3 atlases checked in.",
	},
];

/** The owner's message in a channel of the capture guild, as the Discord surface reports it. */
export function addressed(channel: ChannelKey): InboundMessage {
	return {
		channel,
		messageId: "966666620000000009",
		actor: {
			provider: "discord",
			subject: CAPTURE_OWNER.id,
			name: CAPTURE_OWNER.name,
			surface: "discord",
			roles: [],
			space: CAPTURE_GUILD,
			legacyId: CAPTURE_OWNER.id,
		},
		authorId: CAPTURE_OWNER.id,
		authorName: CAPTURE_OWNER.name,
		authorIsBot: false,
		authorRoleIds: [],
		isDirect: false,
		space: CAPTURE_GUILD,
		mentionsBot: false,
		repliesToBot: false,
		text: "Where are the atlases now?",
		attachments: [],
	};
}

/** The real reader over a channel that holds CAPTURE_CHANNEL, so the capture records its block as the model gets it. */
export function captureChannelContext(): DiscordServices["channelContext"] {
	const reader = new ChannelContextReader({
		read: async () => CAPTURE_CHANNEL,
		owners: async () => [CAPTURE_OWNER.id],
		settings: {},
		logger: silentLogger(),
	});
	return (message, options) => reader.of(message, options);
}
