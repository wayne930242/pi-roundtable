import type {
	AgentDirectory,
	AgentTeam,
	AvatarStudio,
	ChatCommand,
	ConversationModes,
	ConversationPort,
	IdentityService,
	Logger,
	ScheduleStore,
	SkillRegistry,
} from "pi-roundtable";
import type { SessionView, SkillView } from "../api-types.ts";
import type { ConsolePresentation } from "../features.ts";
import type { Gate } from "../gate.ts";
import type { HostApp } from "../host/host-app.ts";
import type { RoomReads } from "../host/reads.ts";
import type { ResolvedOptions } from "../options.ts";
import type { PushMutes } from "../push/mutes.ts";
import type { WebAppRegistry } from "../web-app.ts";
import type { CardLog } from "./card-log.ts";
import type { FileDir } from "./files.ts";
import type { HelperRoutesOptions } from "./helper-routes.ts";
import type { LayoutStore } from "./layout.ts";
import type { PromptApiOptions } from "./prompt-routes.ts";
import type { RoomLog } from "./room-log.ts";
import type { Rooms } from "./rooms.ts";
import type { AppSurface } from "./surface.ts";
import type { TeamApiOptions } from "./team-routes.ts";
import type { WebThreads } from "./threads.ts";
import type { Uploads } from "./uploads.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";

export interface AppApiOptions {
	/** The host's wording: a refusal reaches a client of the API in this locale when the catalog has it. */
	presentation?: ConsolePresentation;
	/** The host's IANA time zone, for the date in a zip's name; absent = UTC. */
	timeZone?: string;
	surface: AppSurface;
	rooms: Rooms;
	log: Pick<RoomLog, "page" | "lastOf" | "removeRoom" | "get" | "startOver">;
	cards: Pick<CardLog, "during" | "removeRoom">;
	uploads: Uploads;
	/** Where stored files are read from. */
	files: FileDir;
	modes: Pick<ConversationModes, "set" | "peek" | "forget">;
	/** The rooms whose push the owners muted. */
	mutes: Pick<PushMutes, "set" | "setMany">;
	/** The dispatch threads, which go with the room they hang under. */
	threads: Pick<
		WebThreads,
		| "under"
		| "removeUnder"
		| "dismiss"
		| "dismissFinished"
		| "dismissFinishedUnder"
		| "restore"
		| "restoreFinished"
	>;
	/** The owners' shared arrangement of the room list: pins and folders. */
	layout: LayoutStore;
	conversations: Pick<ConversationPort, "startFresh">;
	identity: Pick<IdentityService, "principal">;
	/** Present when the schedules pane is served. */
	schedules?: Pick<ScheduleStore, "all" | "get" | "remove">;
	directory: Pick<AgentDirectory, "agent" | "agents" | "group" | "groups">;
	team: TeamApiOptions["team"] &
		HelperRoutesOptions["team"] &
		Pick<AgentTeam, "usableModels" | "defaultModel" | "helpersOn">;
	/** Present when the host has the skills addon: the catalog an agent's skills are chosen from, and the change of what it carries. */
	skills?: {
		catalog(): SkillView[];
		/** The skills an agent carries, built-in ones included: what `/skill:<name>` can name in its room. */
		carried?(agent: string): readonly { name: string; description: string }[];
		attach(
			agent: string,
			add: readonly string[],
			remove: readonly string[],
		): Promise<string[]>;
		/** The registry's documents: a skill's SKILL.md read, saved, made and deleted, and its versions. */
		documents: Pick<
			SkillRegistry,
			| "document"
			| "saveDocument"
			| "createDocument"
			| "documentHistory"
			| "delete"
		>;
		/** The registry's skill groups: listed, saved and deleted. */
		groups: Pick<SkillRegistry, "groups" | "setGroup" | "deleteGroup">;
	};
	/** The Pi extension commands plugins declared safe to run from chat (`PluginContext.chatCommands`). */
	chatCommands?(): readonly ChatCommand[];
	/** Present when the host has prompt documents (the prompts plugin): the main prompts the owner edits. */
	prompts?: PromptApiOptions["prompts"];
	avatars: Pick<AvatarStudio, "serve">;
	/** The read cursors, for each room's unread count and who has read what. */
	reads?: Pick<RoomReads, "unread" | "cursorOf" | "marks">;
	/** Who may be served a file bound to a host room or a page. */
	host?: Pick<HostApp, "mayRead" | "readAll" | "unreadAll">;
	/** The name the app shows for a person. */
	nameOf?(principalId: string): Promise<string>;
	/** Present when the workspace pane is served. */
	workspace?: WorkspaceFiles;
	/** The mount, which a room's agent picture hangs under. */
	mount: string;
	/** How the console signs the person in, as the session reports it. */
	authMode: SessionView["auth"];
	/** Who the app admits; the session reports the person's tier only where it admits more than owners. */
	admission?: ResolvedOptions["admission"];
	/** The area handlers the pieces of the app plug in; without it the API is the owners' as in 0.25. */
	registry?: Pick<WebAppRegistry, "areaFor">;
	/** The onboarding gate; without it nobody is gated. */
	gate?: Pick<Gate, "required">;
	/** The tiers whose people may use push; default owners. */
	pushTiers?: ResolvedOptions["push"]["tiers"];
	/** Whether the yolo and long-running switches are served; `PUT rooms/<key>/mode` answers 404 without them. Default true. */
	modeSwitches?: boolean;
	/** The quiet hours of push, as the settings page shows them. */
	quietHours?: NonNullable<SessionView["quietHours"]>;
	/** Called after a change the other pages should refetch. */
	changed(): void;
	logger: Logger;
}
