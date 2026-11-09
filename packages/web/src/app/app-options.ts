import type { SQL } from "bun";
import type {
	AgentServer,
	ChannelKey,
	ConversationModes,
	ConversationPort,
	EventSink,
	IdentityService,
	Logger,
	ScheduleStore,
} from "pi-roundtable";
import type { Authenticator } from "../auth/authenticator.ts";
import type { ConsolePresentation } from "../features.ts";
import type { Gate } from "../gate.ts";
import type { NoticesMountOptions } from "../notices/mount.ts";
import type { ResolvedOptions } from "../options.ts";
import type { QuietWindow } from "../push/quiet-hours.ts";
import type { Vapid } from "../push/vapid.ts";
import type { WebAppRegistry } from "../web-app.ts";
import type { AppApiOptions } from "./routes.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";

export interface OwnerAppOptions {
	/** The host's wording, for the refusals the API answers with. */
	presentation?: ConsolePresentation;
	/** The host's IANA time zone, for the dates in names it gives files; absent = UTC. */
	timeZone?: string;
	/** The key prefix of the rooms, such as `app`. */
	surface: string;
	/** The path the console is served under, without a trailing slash. */
	mount: string;
	/** The console's own origin. */
	origin: string;
	/** The host's data directory, whose `web/` holds the app's files. */
	dataDir: string;
	/** How long a turn waits on its card before it goes on without the answer, in seconds. */
	cardGraceSeconds: number;
	/** The most bytes of one uploaded file. */
	uploadMaxBytes: number;
	/** How many days a stored file of an agent room is kept; default 30. */
	uploadKeepDays?: number;
	/** The name the app shows for a person; default the principal's own. */
	nameOf?(principalId: string): Promise<string>;
	/** The same-origin URL of a room, and of one of its messages, for a host's links. */
	roomUrl(room: ChannelKey, message?: number): string;
	/** Where the app reports what people do in it (a press on a host's button). */
	events?: Pick<EventSink, "action">;
	authenticator: Pick<Authenticator, "authenticate" | "recheck">;
	/** How the console signs the person in. */
	authMode: ResolvedOptions["auth"]["mode"];
	/** Who the app admits; the page and the session report the tier only where it admits more than owners. */
	admission: ResolvedOptions["admission"];
	/** What the pieces of the app plug in: the kinds of host room, their handlers, who reads them. */
	registry: WebAppRegistry;
	/** The onboarding gate. */
	gate: Gate;
	/** The tiers whose people may use push. */
	pushTiers: ResolvedOptions["push"]["tiers"];
	/** Whether the yolo and long-running switches are served. */
	modeSwitches: boolean;
	/** The longest an open socket lives; for a credential that logout or a new password does not reach. */
	socketLifeMs?: number;
	/** The notices, onboarding and profile pieces: what they read of the options. */
	extras: Pick<NoticesMountOptions, "profiles" | "routing" | "onboarding"> & {
		push: NoticesMountOptions["push"];
	};
	/** Web Push: the server's key (absent with an external sender, which holds it), and how notifications read. */
	push: {
		vapid?: Vapid;
		/** The `sub` of the VAPID token; absent = push is not set up and nothing is sent. */
		subject: string | undefined;
		preview: boolean;
		/** When an agent's post and a notice are not pushed, on the clock of `timeZone`; absent = any hour. */
		quietHours?: QuietWindow;
		/** The IANA zone the quiet hours are read in: the console's. */
		timeZone: string;
		endpointHosts: readonly string[];
		/** The HTTP client the posts go through. */
		fetch?: typeof fetch;
		/** The path a tap on a room's notification opens, under the origin. */
		urlOf(room: string): string;
	};
	database: SQL;
	agents: AgentServer;
	/**
	 * Present when the host has the skills addon: the catalog an agent's skills are chosen from,
	 * how they change, and the registry's documents.
	 */
	skills?: AppApiOptions["skills"];
	/** The extension commands plugins declared safe to run from chat. */
	chatCommands?: AppApiOptions["chatCommands"];
	/** Present when the host has prompt documents: the main prompts the owner edits. */
	prompts?: AppApiOptions["prompts"];
	/** Present when the workspace pane is served. */
	workspace?: WorkspaceFiles;
	modes: ConversationModes;
	identity: IdentityService;
	/** Present when the schedules pane is served. */
	schedules?: ScheduleStore;
	conversations: ConversationPort;
	/** Called after a change the other pages should refetch. */
	changed(): void;
	logger: Logger;
}
