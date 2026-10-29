import { join } from "node:path";
import type { SQL } from "bun";
import type {
	AgentServer,
	ChannelKey,
	ConversationModes,
	ConversationPort,
	DirectChannelProvider,
	IdentityService,
	Logger,
	Migration,
	ScheduleStore,
	WebSocketRoute,
} from "pi-roundtable";
import type { Authenticated, Authenticator } from "../auth/authenticator.ts";
import { PushApi } from "../push/api.ts";
import { webPushChannel } from "../push/channel.ts";
import { EndpointPolicy } from "../push/endpoint.ts";
import { PushMutes } from "../push/mutes.ts";
import { QuietClock, type QuietWindow } from "../push/quiet-hours.ts";
import { PushSender } from "../push/sender.ts";
import { PushSubscriptions } from "../push/subscriptions.ts";
import { PushService } from "../push/triggers.ts";
import type { Vapid } from "../push/vapid.ts";
import { CardLog } from "./card-log.ts";
import { OwnerDesk } from "./desk.ts";
import { FileDir } from "./files.ts";
import { Presence } from "./presence.ts";
import { RoomLog } from "./room-log.ts";
import { Rooms } from "./rooms.ts";
import { AppApi, partsOf } from "./routes.ts";
import { SocketRoute } from "./socket.ts";
import { type AppSocket, Sockets } from "./sockets.ts";
import { AppSurface } from "./surface.ts";
import { WebThreads } from "./threads.ts";
import { Uploads } from "./uploads.ts";

/** Changes closer together than this reach the sockets as one `changed` frame. */
const CHANGED_COALESCE_MS = 250;
/** How often old files are swept: hourly. */
const SWEEP_EVERY_MS = 3_600_000;

/** The tables the app keeps; the plugin lists them as its own migrations. */
export const APP_MIGRATIONS: readonly Migration[] = [
	RoomLog.migration,
	CardLog.migration,
	WebThreads.migration,
	PushSubscriptions.migration,
	PushMutes.migration,
];

export interface OwnerAppOptions {
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
	authenticator: Pick<Authenticator, "authenticate">;
	/** How the console signs the person in. */
	authMode: "none" | "password" | "verifier";
	/** The longest an open socket lives; for a credential that logout or a new password does not reach. */
	socketLifeMs?: number;
	/** Web Push: the server's key, and how notifications read. */
	push: {
		vapid: Vapid;
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
	modes: ConversationModes;
	identity: IdentityService;
	/** Present when the schedules pane is served. */
	schedules?: ScheduleStore;
	conversations: ConversationPort;
	/** Called after a change the other pages should refetch. */
	changed(): void;
	logger: Logger;
}

/**
 * The owner app's server side, wired: the rooms as a chat surface, the cards, the WebSocket, the
 * stored messages, uploads and files, and the REST under the mount. The plugin contributes its
 * `surface` and `migrations`, adds `websocket` to its route, and hands `handle` the requests the
 * console's authenticator admitted.
 */
export class OwnerApp {
	readonly surface: AppSurface;
	readonly websocket: WebSocketRoute<AppSocket>;
	/** Reaches an owner through the app: a line in the home room, and a push to their devices. */
	readonly directChannel: DirectChannelProvider;
	readonly #api: AppApi;
	readonly #push: PushApi;
	readonly #sockets: Sockets;
	readonly #desk: OwnerDesk;
	readonly #presence: Presence;
	readonly #uploads: Uploads;
	readonly #options: OwnerAppOptions;
	readonly #unsubscribe: (() => void)[] = [];
	#sweeper: ReturnType<typeof setInterval> | undefined;
	#pending: ReturnType<typeof setTimeout> | undefined;

	constructor(options: OwnerAppOptions) {
		this.#options = options;
		const { agents, modes, identity, logger } = options;
		const sockets = new Sockets(logger);
		const log = new RoomLog(options.database);
		const cards = new CardLog(options.database);
		const stored = new FileDir(join(options.dataDir, "web", "files"));
		const waiting = new FileDir(join(options.dataDir, "web", "uploads"));
		const uploads = new Uploads(waiting, stored, {
			maxBytes: options.uploadMaxBytes,
		});
		const threads = new WebThreads(options.database);
		const subscriptions = new PushSubscriptions(options.database);
		const mutes = new PushMutes(options.database);
		const policy = new EndpointPolicy(options.push.endpointHosts);
		const quietClock = options.push.quietHours
			? new QuietClock(options.push.quietHours, options.push.timeZone)
			: undefined;
		const push = new PushService({
			subscriptions,
			sender: new PushSender({
				vapid: options.push.vapid,
				subject: options.push.subject,
				policy,
				...(options.push.fetch ? { fetch: options.push.fetch } : {}),
				logger,
			}),
			identity,
			visible: (principalId) => sockets.anyVisible(principalId),
			preview: options.push.preview,
			...(quietClock ? { quiet: (at: number) => quietClock.quietAt(at) } : {}),
			muted: (room) => mutes.has(room),
			urlOf: options.push.urlOf,
			logger,
		});
		this.#push = new PushApi({
			vapid: options.push.vapid,
			policy,
			subscriptions,
			identity,
			enabled: options.push.subject !== undefined,
		});
		// The desk starts a late answer's turn through the socket route, which is made after it.
		let route: SocketRoute | undefined;
		const desk = new OwnerDesk({
			broadcast: (frame) => sockets.broadcast(frame),
			graceMs: options.cardGraceSeconds * 1000,
			closed: (card) => cards.record(card),
			opened: (room, frame) => {
				const cap =
					frame.kind === "approval" &&
					frame.purpose === "turn-timeout" &&
					modes.peek(room).longRunning;
				push.card(room, frame.title, cap).catch(() => undefined);
			},
			resume: async (room, by, text) => {
				if (!route) throw new Error("the app socket route is not ready");
				await route.say(room, by, text, []);
			},
			namesOf: async (ids) =>
				Promise.all(
					ids.map(
						async (id) => (await identity.principal(id))?.displayName ?? id,
					),
				),
			logger,
		});
		let presence: Presence | undefined;
		const surface = new AppSurface({
			surface: options.surface,
			sockets,
			desk,
			log,
			files: stored,
			uploads,
			threads,
			canHost: async (parent) => {
				const room = await rooms.resolve(parent);
				return room !== undefined && room.kind !== "thread";
			},
			changed: () => this.changed(),
			unprompted: (room, author, text) => {
				push.reply(room, author, text).catch(() => undefined);
			},
			activity: () => presence?.schedule(),
			logger,
		});
		presence = new Presence({
			team: agents.team,
			sockets,
			working: () => surface.workingAgents(),
			logger,
		});
		const rooms = new Rooms({
			surface: options.surface,
			mount: options.mount,
			directory: agents.directory,
			team: agents.team,
			avatars: agents.avatars,
			threads,
			log,
			modes,
			mutes,
			activity: (room) => surface.activityOf(room),
		});
		route = new SocketRoute({
			path: `${options.mount}/api/socket`,
			origin: options.origin,
			authenticator: options.authenticator,
			...(options.socketLifeMs === undefined
				? {}
				: { maxLifeMs: options.socketLifeMs }),
			sockets,
			surface,
			desk,
			rooms,
			uploads,
			presence,
			identity,
			conversations: options.conversations,
			logger,
		});
		this.websocket = route.route();
		this.directChannel = webPushChannel({
			surface: options.surface,
			identity,
			home: () => rooms.homeKey(),
			post: async (room, text) => {
				await surface.publish({
					room,
					kind: "system",
					author: "Notice",
					text,
				});
			},
			push,
		});
		this.#api = new AppApi({
			surface,
			rooms,
			log,
			cards,
			uploads,
			files: stored,
			modes,
			mutes,
			conversations: options.conversations,
			identity,
			...(options.schedules ? { schedules: options.schedules } : {}),
			directory: agents.directory,
			team: agents.team,
			avatars: agents.avatars,
			mount: options.mount,
			authMode: options.authMode,
			...(options.push.quietHours
				? {
						quietHours: {
							...options.push.quietHours,
							timeZone: options.push.timeZone,
						},
					}
				: {}),
			changed: options.changed,
			logger,
		});
		this.surface = surface;
		this.#sockets = sockets;
		this.#desk = desk;
		this.#presence = presence;
		this.#uploads = uploads;
		this.#unsubscribe.push(
			modes.onChange((channel, mode) => {
				if (!rooms.ownsKey(channel)) return;
				sockets.broadcast({
					type: "mode",
					room: channel,
					yolo: mode.yolo,
					longRunning: mode.longRunning,
				});
			}),
			modes.onAutoApproved((entry) => {
				if (!rooms.ownsKey(entry.channel)) return;
				this.#autoApproved(entry.channel, entry.tool, entry.action).catch(
					(error: unknown) =>
						logger.warn({ err: error }, "a yolo approval was not recorded"),
				);
			}),
		);
	}

	/** Answers a path under the mount that is the app's; undefined for any other. */
	async handle(
		request: Request,
		rest: string,
		admission: Authenticated,
	): Promise<Response | undefined> {
		const parts = partsOf(rest);
		const pushed = parts
			? await this.#push.handle(request, parts, admission)
			: undefined;
		return pushed ?? this.#api.handle(request, rest, admission);
	}

	/** Tells every open socket the team or the room list may differ, once changes settle. */
	changed(): void {
		if (this.#pending) return;
		this.#pending = setTimeout(() => {
			this.#pending = undefined;
			this.#sockets.broadcast({ type: "changed" });
		}, CHANGED_COALESCE_MS);
	}

	start(): void {
		this.#uploads.adopt();
		this.#sweep();
		this.#sweeper = setInterval(() => this.#sweep(), SWEEP_EVERY_MS);
	}

	/** Closes the sockets and the cards, and stops the sweeping; the host has stopped its turns by now. */
	stop(): void {
		clearInterval(this.#sweeper);
		this.#sweeper = undefined;
		clearTimeout(this.#pending);
		this.#pending = undefined;
		for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
		this.#desk.stop();
		this.#presence.stop();
		this.#sockets.closeAll(1001, "stopping");
	}

	#sweep(): void {
		try {
			const dropped = this.#uploads.sweep();
			if (dropped > 0)
				this.#options.logger.info({ dropped }, "old app files deleted");
		} catch (error) {
			this.#options.logger.warn({ err: error }, "old app files not deleted");
		}
	}

	/** Records and shows that yolo mode approved a held call in a room. */
	async #autoApproved(
		room: ChannelKey,
		tool: string,
		action: string,
	): Promise<void> {
		await this.surface.publish({
			room,
			kind: "system",
			author: "Yolo mode",
			text: `Yolo mode approved: ${action}`,
		});
		this.#sockets.broadcast({ type: "auto_approved", room, tool, action });
	}
}
