import type { ChannelKey } from "pi-roundtable";
import type { ConnectorsView, PartyView, SkillView } from "./api-types.ts";

/** Trusted host integrations. They receive validated keys, never request-selected file paths. */
export interface ConsoleFeatures {
	party?: {
		contains(key: ChannelKey): boolean;
		/** The host binds its channel store, runtime status and existing session paths here. */
		list(): Promise<PartyView[]>;
	};
	schedules?: { count(key: ChannelKey): Promise<number> };
	cleanup?: {
		/** Archives the conversation, preserving memory; the host waits for active turns. */
		startFresh(key: ChannelKey): Promise<string>;
		/** Only stored owner/outside conversations are admitted by the console. */
		deleteConversation(key: ChannelKey): Promise<"deleted" | "busy">;
	};
	skills?: {
		catalog(): SkillView[];
		/** Read only the selected catalog entry, with a host-enforced byte limit. */
		read(
			name: string,
		): Promise<{ frontmatter: Record<string, unknown>; body: string }>;
		/**
		 * Show why a skill could not be read (the catalog's `missing` text, or the read error's
		 * message, cut at 300 characters) after the fixed message. Off by default: the reason may
		 * name a path.
		 */
		errorDetail?: boolean;
	};
	connectors?: {
		gateways(): Promise<ConnectorsView["gateways"]>;
		servers(): Promise<{ name: string; tools: string[] }[]>;
		usedBy(server: string): string[];
		/** Optional administrator link, limited to HTTP(S) or an absolute local path. */
		adminUrl?: string;
	};
}

/** English source strings are keys; a host supplies its own wording without a page fork. */
export interface ConsolePresentation {
	locale?: string;
	messages?: Readonly<Record<string, string>>;
}

export function message(
	presentation: ConsolePresentation | undefined,
	source: string,
): string {
	return presentation?.messages?.[source] ?? source;
}

export function safeAdminUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	if (url.startsWith("/") && !url.startsWith("//") && !url.includes("\\"))
		return url;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:"
			? parsed.href
			: undefined;
	} catch {
		return undefined;
	}
}
