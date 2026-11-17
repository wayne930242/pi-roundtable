import { DISCORD, type DiscordServices } from "../builtin/discord.ts";
import {
	ATTACHMENT_READ_MAX_BYTES,
	type AttachmentFacts,
	readAttachment,
} from "../discord/attachment-read.ts";
import { CommandCollection } from "../discord/command-collection.ts";
import type { ComposedCommands } from "../discord/compose-commands.ts";
import type {
	CommandGuard,
	CommandRegistrar,
	InteractionContribution,
} from "../discord/interaction-module.ts";
import { commandGuard, ownerRootCommand } from "../discord/owner-command.ts";
import type { DiscordPoster } from "../discord/poster/poster.ts";
import type { DiscordVoice } from "../discord/voice/voice.ts";
import { silentLogger } from "../kernel/log.ts";
import { fakeDiscordPoster } from "./fake-poster.ts";
import { type ServicePair, servicePair } from "./service-pair.ts";

/** A stand-in for the Discord plugin's `DISCORD` service, made by `fakeDiscord()`. */
export interface FakeDiscord {
	/** Give this to `testPlugin`'s `services` option: `{ services: [discord.service] }`. */
	readonly service: ServicePair;
	/** What `DISCORD.commands` is to the plugin: the real registrar, which refuses what the Discord plugin refuses. */
	readonly commands: CommandRegistrar;
	/** What `DISCORD.poster` is: the one the test gave, else a `fakeDiscordPoster()`. */
	readonly poster: DiscordPoster;
	/** What `DISCORD.guard` is: the owner, `owner` unless the test gave another id, serving the root command. */
	readonly guard: CommandGuard;
	/** Every contribution the plugin added, in the order it added them. */
	added(): readonly InteractionContribution[];
	/** The tree the Discord plugin would register, composed under the root command the fake was made with. */
	compose(): ComposedCommands;
}

/**
 * A file `fakeDiscord`'s `readAttachment` serves, as if posted with a message in a channel. Its
 * `channelId`, `messageId` and `id` are Discord ids, digits only, as the real call requires.
 */
export interface FakeDiscordAttachment {
	channelId: string;
	messageId: string;
	/** The file's id, as `AttachmentRef.id` gives it. */
	id: string;
	name: string;
	contentType?: string;
	/** Its bytes; a string is UTF-8. */
	bytes: Uint8Array | string;
	title?: string;
	description?: string;
	/** Discord's CDN no longer serves it: a read rejects as `gone`. */
	gone?: boolean;
}

/**
 * `DISCORD.readAttachment` over `files`, with the real one's checks and errors (an id that is no
 * Discord id, a file not on its message, a message of another channel, over `maxBytes`, gone),
 * downloading from a stand-in CDN.
 */
function fakeAttachmentReader(
	files: readonly FakeDiscordAttachment[],
	maxBytes: number,
): DiscordServices["readAttachment"] {
	const bytesOf = (file: FakeDiscordAttachment) =>
		typeof file.bytes === "string"
			? new TextEncoder().encode(file.bytes)
			: file.bytes;
	const url = (file: FakeDiscordAttachment) =>
		`https://cdn.discordapp.com/attachments/${file.channelId}/${file.id}/${encodeURIComponent(file.name)}`;
	const fetchImpl = (async (address: string) => {
		const file = files.find((f) => url(f) === address);
		return file && !file.gone
			? new Response(bytesOf(file))
			: new Response(null, { status: 404 });
	}) as unknown as typeof fetch;
	return (request) =>
		readAttachment(
			{
				files: async (channelId, messageId) => {
					const on = files.filter(
						(f) => f.channelId === channelId && f.messageId === messageId,
					);
					if (on.length === 0) return undefined;
					return on.map(
						(f): AttachmentFacts => ({
							id: f.id,
							name: f.name,
							contentType: f.contentType ?? null,
							size: bytesOf(f).byteLength,
							url: url(f),
							title: f.title ?? null,
							description: f.description ?? null,
						}),
					);
				},
			},
			request,
			{ maxBytes, fetchImpl },
		);
}

/**
 * A `DISCORD` service for a plugin that adds slash commands, without a Discord connection: the
 * plugin's `commands.add` calls are recorded, and `compose()` shows the tree Discord would get.
 * `rootCommand` is the root command's name, `roundtable` by default. `channelContext` is what
 * `DISCORD.channelContext` answers, by default no context, as on a host with it off. `voice` is
 * what `DISCORD.voice` is, such as a `fakeDiscordVoice()`; without it the plugin reads none, as on
 * a host with `discord.voice` off. `attachments` are the files `DISCORD.readAttachment` serves,
 * none by default, read at most `attachmentMaxBytes` (default 10 MiB) as the host's
 * `discord.attachmentRead.maxBytes` caps them. Only `commands`, `guard`, `poster`,
 * `channelContext`, `readAttachment` and `voice` are given; reading another member throws.
 */
export function fakeDiscord(
	options: {
		ownerId?: string;
		rootCommand?: string;
		channelContext?: DiscordServices["channelContext"];
		poster?: DiscordPoster;
		voice?: DiscordVoice;
		attachments?: readonly FakeDiscordAttachment[];
		attachmentMaxBytes?: number;
	} = {},
): FakeDiscord {
	const collection = new CommandCollection();
	const { rootCommand = "roundtable" } = options;
	const guard = commandGuard({
		ownerId: options.ownerId ?? "owner",
		root: rootCommand,
		logger: silentLogger(),
	});
	const poster = options.poster ?? fakeDiscordPoster();
	return {
		service: servicePair(DISCORD, {
			commands: collection.registrar,
			guard,
			poster,
			channelContext: options.channelContext ?? (async () => undefined),
			readAttachment: fakeAttachmentReader(
				options.attachments ?? [],
				options.attachmentMaxBytes ?? ATTACHMENT_READ_MAX_BYTES,
			),
			voice: options.voice,
		}),
		poster,
		commands: collection.registrar,
		guard,
		added: () => collection.added(),
		compose: () => collection.compose(ownerRootCommand(rootCommand)),
	};
}
