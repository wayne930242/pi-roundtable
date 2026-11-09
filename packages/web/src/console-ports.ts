import type {
	AgentTeam,
	ChannelKey,
	ConversationRecord,
	ConversationRegistry,
	IdentityService,
	Logger,
	QueuePort,
	SpeakerMemory,
	Tier,
} from "pi-roundtable";
import type {
	ChannelName,
	GateStepView,
	KindLinkView,
	PageLinkView,
	PaneName,
} from "./api-types.ts";
import type { ConsoleFeatures, ConsolePresentation } from "./features.ts";
import type { Visitor } from "./visitors.ts";

/** What the app adds to the page's config for one visitor, where it admits more than the owners. */
export interface AccessView {
	/** Who may use push, and the key browsers subscribe against when an external sender holds it. */
	push: { tiers: readonly Tier[]; key?: string; subscribe?: string };
	/** The required steps the visitor still owes. */
	gate(visitor: Visitor): Promise<GateStepView[]>;
}

export interface ConsolePorts {
	title: string;
	timeZone: string;
	/** The owners' panes, which every host serves. */
	panes: readonly PaneName[];
	/** The panes of the other tiers, when the host admits more than its owners; absent = none. */
	tierPanes?: Readonly<Record<Tier, readonly PaneName[]>>;
	/** Present when the host admits more than its owners (`admission: "access"`). */
	access?: AccessView;
	/**
	 * The pages and kinds of room the host registered, as far as this visitor may see them. The
	 * config carries them whatever the admission, but only when there are any, so a host that
	 * registers none sends the page exactly what it did before.
	 */
	hosted?: (visitor: Visitor) => Promise<{
		pages: PageLinkView[];
		kinds: KindLinkView[];
	}>;
	/** The host's `sessions/` directory. */
	sessionsDir: string;
	/** Present when the overview pane is served, or the agent server is there to classify channels. */
	team?: Pick<
		AgentTeam,
		"status" | "owns" | "teamId" | "guildId" | "discordGuild"
	>;
	/**
	 * The web app's surface, when it hosts the agents' and groups' rooms: the overview then names
	 * each one's room, which its start-over resets instead of the Discord channel's conversation.
	 */
	roomSurface?: string;
	queue: Pick<QueuePort, "size">;
	/** Undefined when Discord no longer knows the channel; throws when it cannot be asked. */
	channelName?: (channelId: string) => Promise<ChannelName | undefined>;
	/** A principal's memory; present when the notes pane is served. */
	memoryOf?: (
		principalId: string,
	) => Pick<SpeakerMemory, "list" | "search" | "add" | "update" | "removeById">;
	/** The host's principals, read only: whose notes the pane may show, and the names of conversations' principals. */
	people?: Pick<IdentityService, "principal" | "list">;
	/** Conversations the console must not list or read; `record` is what the registry holds of it, if anything. */
	exclude?: (key: ChannelKey, record?: ConversationRecord) => boolean;
	/** The host's conversation registry; without it only the conversations found by name are listed. */
	registry?: Pick<ConversationRegistry, "list" | "get">;
	/** Text a relayed message begins with, which is not the owner's words. */
	relayNotes: readonly string[];
	/** Called after a note is written, so every open page refreshes. */
	changed(): void;
	logger: Logger;
	features?: ConsoleFeatures;
	presentation?: ConsolePresentation;
	mountPath?: string;
	look?: "modern" | "camelot";
	/** The host's six skin tones, which the page draws every character with. */
	characterSkins?: readonly string[];
	/** Present when the owner app is served: its rooms' key prefix, for the page. */
	app?: { surface: string; protocol: string; modes?: false };
}
