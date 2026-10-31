import type { ChannelKey } from "pi-roundtable";
import type { ConnectorsView, PartyView, SkillView } from "./api-types.ts";
import { builtInMessages } from "./i18n/index.ts";

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
		/** The owner's connectors, managed from the page; pi-roundtable-mcp's `CONNECTORS` fits it. */
		manage?: ConnectorManagement;
	};
	/** Which channels outside agents may use through a bundle's MCP URL; absent hides the section. */
	mcpGrants?: McpGrants;
}

/**
 * One connector. `url` may hold a credential in its path or query, so the console shows only its
 * scheme and host.
 */
export interface ManagedConnector {
	name: string;
	url: string;
	description: string;
	/** Its virtual server; absent when its tools could not be read. */
	server?: { tools: readonly string[] } | undefined;
}

/**
 * Connector management. A rejection whose error carries `refusal: true` is shown to the owner as
 * its message; any other is logged and answered as the service being unavailable.
 */
export interface ConnectorManagement {
	list(): readonly ManagedConnector[] | Promise<readonly ManagedConnector[]>;
	/** `token` is write-only: the console never returns or logs it. */
	add(input: {
		name: string;
		url: string;
		description: string;
		header?: string;
		token?: string;
	}): Promise<{ connector: ManagedConnector; skipped: readonly string[] }>;
	describe(name: string, description: string): Promise<unknown>;
	remove(name: string): Promise<void>;
}

/** The owner acting through the console, for a host that maps them to their Discord identity. */
export interface ConsoleActor {
	principalId: string;
	/** The identity they spoke as, `<provider>:<subject>`. */
	speakerId: string;
}

export interface McpGrantChannel {
	channelId: string;
	guildName: string;
	channelName: string;
	/** False when the bot cannot see the channel now. */
	visible: boolean;
	/** The name and purpose an agent sees. */
	displayName: string;
	description: string;
	operations: readonly string[];
	authorizedAt: Date;
	audit: readonly { tool: string; status: string; createdAt: Date }[];
}

/**
 * The owner's MCP bundles, as `/<root> mcp` manages them; pi-roundtable-mcp's `REMOTE_MCP` fits
 * it once the host closes over its Discord client and supplies the channels and the actor's
 * Discord ID. Refusals follow `ConnectorManagement`'s rule.
 */
export interface McpGrants {
	/** Every operation a grant may allow, in order. */
	operations: readonly { id: string; label: string }[];
	bundles(): Promise<
		readonly { name: string; grants: readonly McpGrantChannel[] }[]
	>;
	/** The channels the owner may pick to authorize. */
	channels(
		actor: ConsoleActor,
	): Promise<readonly { id: string; name: string; guild: string }[]>;
	revoke(bundle: string, channelId: string): Promise<void>;
	describe(
		bundle: string,
		channelId: string,
		change: { displayName?: string; description?: string },
	): Promise<void>;
	/** The new URL, returned this once. */
	rotate(bundle: string): Promise<{ url: string }>;
	/** Adds a channel to a bundle, creating it when new; a new bundle's URL is returned this once. */
	authorize(
		input: {
			bundle: string;
			channelId: string;
			operations: readonly string[];
			displayName?: string;
			description?: string;
		},
		actor: ConsoleActor,
	): Promise<{ bundle: string; url?: string | undefined }>;
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
	return (
		presentation?.messages?.[source] ??
		builtInMessages(presentation?.locale)?.[source] ??
		source
	);
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
