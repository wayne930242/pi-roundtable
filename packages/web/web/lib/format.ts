import type { ChannelName, ConversationView } from "../../src/api-types.ts";

/** `just now`, `12 min ago`, `3 h ago`, `2 d ago`, or the date for anything older than a week. */
export function ago(
	iso: string | undefined,
	now: number,
	timeZone: string,
): string {
	if (!iso) return "—";
	const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	return days <= 7 ? `${days} d ago` : when(iso, timeZone);
}

/** A date and time in the host's zone. */
export function when(iso: string, timeZone: string): string {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone,
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(iso));
}

export function size(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function kilo(tokens: number): string {
	return `${Math.round(tokens / 1000)}k`;
}

/** The channel's name as the lists show it, with its server. */
export function channelTitle(
	channel: ChannelName | undefined,
	id: string,
): { title: string; detail?: string } {
	switch (channel?.kind) {
		case "dm":
			return {
				title: channel.name
					? `Direct message · ${channel.name}`
					: "Direct message",
			};
		case "guild":
			return { title: `#${channel.name}`, detail: channel.guild };
		case "gone":
			return { title: id, detail: "channel no longer exists" };
		default:
			return { title: id };
	}
}

/** A link that opens the channel in Discord; direct messages open under `@me`. */
export function discordUrl(
	channelId: string,
	guildId: string | undefined,
): string {
	return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}`;
}

/** Today in the host's zone as `YYYY-MM-DD`, which decides whether an event has passed. */
export function today(timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

/** What a conversation is called in lists and headings. */
export function conversationTitle(conversation: ConversationView): string {
	if (conversation.kind === "outside")
		return (
			conversation.firstMessage || `Session ${conversation.id.slice(0, 8)}`
		);
	const { title } = channelTitle(conversation.channel, conversation.id);
	return conversation.member ? `${title} · ${conversation.member}` : title;
}
