import type { InboundMessage } from "pi-roundtable";
import type {
	ChannelContext,
	ChannelContextMessage,
	ChannelContextOptions,
} from "pi-roundtable/discord";
import { formatChannelContext } from "pi-roundtable/discord";
import type { HostAuthorKind, RoomMessage } from "../api-types.ts";
import { PAGE_LIMIT } from "../app/room-log.ts";
import type { HostContext } from "./host-context.ts";

const DEFAULT_FETCH = 50;
const DEFAULT_KEEP = 15;
const DEFAULT_CHARS = 500;
/** How many delivered message ids are remembered per room, and how many rooms. */
const SEEN_PER_ROOM = 500;
const SEEN_ROOMS = 1_000;

type Source = Parameters<NonNullable<ChannelContextOptions["authors"]>>[0];

const positive = (name: string, value: number, most: number): number => {
	if (!Number.isInteger(value) || value < 1 || value > most)
		throw new RangeError(
			`channel context option ${name} must be a whole number from 1 to ${most}, got ${value}`,
		);
	return value;
};

/** Whose a stored message of a host room is; a message without a kind is read from its row's. */
function authorKindOf(message: RoomMessage): HostAuthorKind {
	if (message.authorKind) return message.authorKind;
	if (message.kind === "agent") return "assistant";
	return message.kind === "system" ? "notice" : "member";
}

/** What the channel context reads of one stored message of a host room. */
function sourceOf(message: RoomMessage): Source {
	const kind = authorKindOf(message);
	return {
		id: String(message.id),
		authorId: message.principalId ?? kind,
		authorName: message.author,
		bot: false,
		own: kind === "assistant",
		...(kind === "external" ? { external: true as const } : {}),
		attachments: message.files.map((file) => ({
			name: file.name,
			contentType: file.type,
			size: file.size,
			url: `api/files/${file.id}`,
		})),
		at: Date.parse(message.at),
		text: message.text,
	};
}

/**
 * The app surface's `channelContext` for a host room: what was said in it since the assistant
 * last posted, before the message that addressed it, as the core's block of channel messages. An
 * outsider's words read as `external`, a notice line is not in the channel as far as the context
 * goes, and a message already handed to the conversation is not handed again. Anything but a host
 * room has none: an agent room is one person's.
 */
export function hostChannelContext(
	ctx: Pick<HostContext, "registry" | "log">,
): (
	message: InboundMessage,
	options?: ChannelContextOptions,
) => Promise<ChannelContext | undefined> {
	const seen = new Map<string, Set<string>>();
	return async (message, options = {}) => {
		const room = message.channel;
		if (!ctx.registry.isHostRoom(room)) return undefined;
		const fetch = positive("fetch", options.fetch ?? DEFAULT_FETCH, PAGE_LIMIT);
		const keep = positive("keep", options.keep ?? DEFAULT_KEEP, 100);
		const chars = positive(
			"messageChars",
			options.messageChars ?? DEFAULT_CHARS,
			20_000,
		);
		const addressed = /^app-(\d+)$/.exec(message.messageId)?.[1];
		const page = await ctx.log.page(
			room,
			addressed === undefined ? undefined : Number(addressed),
			fetch,
		);
		const sources = page.messages.map((one) => ({
			source: sourceOf(one),
			notice: authorKindOf(one) === "notice",
		}));
		type Entry = (typeof sources)[number];
		const verdict = (entry: Entry) => {
			const given = options.authors?.(entry.source);
			if (given === "keep" || given === "skip" || given === "end") return given;
			if (entry.notice) return "skip";
			return entry.source.own ? "end" : "keep";
		};
		const considered = sources.filter((entry) => verdict(entry) !== "skip");
		const lastEnd = considered.findLastIndex(
			(entry) => verdict(entry) === "end",
		);
		const known = seen.get(room) ?? new Set<string>();
		const fresh = considered
			.slice(lastEnd + 1)
			.filter(
				(entry) =>
					verdict(entry) === "keep" &&
					!known.has(entry.source.id) &&
					entry.source.text !== "",
			)
			.slice(-keep);
		// What was in the window is not handed over again, kept or not.
		for (const entry of considered.slice(lastEnd + 1))
			known.add(entry.source.id);
		seen.delete(room);
		seen.set(room, new Set([...known].slice(-SEEN_PER_ROOM)));
		if (seen.size > SEEN_ROOMS) {
			const oldest = seen.keys().next().value;
			if (oldest !== undefined) seen.delete(oldest);
		}
		if (fresh.length === 0) return undefined;
		const messages: ChannelContextMessage[] = fresh.map(({ source }) => ({
			id: source.id,
			authorId: source.authorId,
			authorName: source.authorName,
			bot: false,
			owner: false,
			...(source.external ? { external: true } : {}),
			text:
				source.text.length > chars
					? `${source.text.slice(0, chars)}…`
					: source.text,
			at: new Date(source.at),
			attachments: (source.attachments ?? []).map((file) => ({
				...file,
				messageId: source.id,
			})),
		}));
		return { messages, text: formatChannelContext(messages) };
	};
}
