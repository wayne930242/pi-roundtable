import { join } from "node:path";
import type {
	ChannelKey,
	DirectChannelProvider,
	RoomLayoutService,
	WebSocketRoute,
} from "pi-roundtable";
import { channelKey, isHelper, roomOf } from "pi-roundtable";
import { APP_CLOSE_EXPIRED } from "../api-types.ts";
import type { Authenticated } from "../auth/authenticator.ts";
import { HostCardLog } from "../host/cards.ts";
import { HostApp } from "../host/host-app.ts";
import { RoomReads } from "../host/reads.ts";
import { mountNotices, type NoticesMount } from "../notices/mount.ts";
import { PersonCharacters } from "../profile/characters.ts";
import type { PushApi } from "../push/api.ts";
import { webPushChannel } from "../push/channel.ts";
import { EndpointPolicy } from "../push/endpoint.ts";
import { PushMutes, roomMuted } from "../push/mutes.ts";
import { QuietClock } from "../push/quiet-hours.ts";
import { PushSender } from "../push/sender.ts";
import { PushSubscriptions } from "../push/subscriptions.ts";
import { PushService } from "../push/triggers.ts";
import type { OwnerAppOptions } from "./app-options.ts";
import { sweepApp } from "./app-sweep.ts";
import { BlockAnswering } from "./block-answering.ts";
import { CardLog } from "./card-log.ts";
import { OwnerDesk } from "./desk.ts";
import { FileDir } from "./files.ts";
import { postHelpersEnded } from "./helpers-ended.ts";
import { RoomLayout } from "./layout.ts";
import { Presence } from "./presence.ts";
import { roomLayoutService } from "./room-layout-service.ts";
import { RoomLog } from "./room-log.ts";
import { Rooms, roomModeOf } from "./rooms.ts";
import { AppApi, partsOf } from "./routes.ts";
import { SocketRoute } from "./socket.ts";
import { type AppSocket, type Audience, Sockets } from "./sockets.ts";
import { AppSurface } from "./surface.ts";
import { WebThreads } from "./threads.ts";
import { Uploads } from "./uploads.ts";

export { APP_MIGRATIONS } from "./migrations.ts";

/** Changes closer together than this reach the sockets as one `changed` frame. */
const CHANGED_COALESCE_MS = 250;
/** How often old files are swept: hourly. */
const SWEEP_EVERY_MS = 3_600_000;

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
	/** The room groups the agent tools place rooms in, provided as `ROOM_LAYOUT`. */
	readonly roomLayout: RoomLayoutService;
	readonly #api: AppApi;
	readonly #push: PushApi;
	readonly #mounted: NoticesMount;
	readonly #sockets: Sockets;
	readonly #desk: OwnerDesk;
	readonly #presence: Presence;
	readonly #uploads: Uploads;
	readonly #host: HostApp;
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
			...(options.uploadKeepDays === undefined
				? {}
				: { keepDays: options.uploadKeepDays }),
		});
		const reads = new RoomReads(options.database);
		const hostCards = new HostCardLog(options.database);
		const nameOf =
			options.nameOf ??
			(async (id: string) => (await identity.principal(id))?.displayName ?? id);
		// The host rooms read their context once the surface exists; the surface asks for it per turn.
		let hostApp: HostApp | undefined;
		const threads = new WebThreads(options.database);
		const subscriptions = new PushSubscriptions(options.database);
		const mutes = new PushMutes(options.database);
		const policy = new EndpointPolicy(options.push.endpointHosts);
		const quietClock = options.push.quietHours
			? new QuietClock(options.push.quietHours, options.push.timeZone)
			: undefined;
		const quiet = quietClock
			? (at: number) => quietClock.quietAt(at)
			: undefined;
		const held = roomMuted(
			mutes,
			threads,
			channelKey(options.surface, "thread."),
		);
		const characters = new PersonCharacters(options.database);
		const mounted = mountNotices({
			database: options.database,
			logger,
			registry: options.registry,
			gate: options.gate,
			sockets,
			identity,
			...(options.extras.profiles ? { profiles: options.extras.profiles } : {}),
			characters,
			subscriptions,
			policy,
			mount: options.mount,
			routing: options.extras.routing,
			push: options.extras.push,
			...(quiet ? { quiet } : {}),
			...(options.push.vapid ? { vapid: options.push.vapid } : {}),
			onboarding: options.extras.onboarding,
		});
		const push = new PushService({
			hostRoom: (room) => options.registry.isHostRoom(room),
			subscriptions,
			// The app signs only with its own key; with an external sender it queues for it instead.
			...(options.push.vapid
				? {
						sender: new PushSender({
							vapid: options.push.vapid,
							subject: options.push.subject,
							policy,
							...(options.push.fetch ? { fetch: options.push.fetch } : {}),
							logger,
						}),
					}
				: {}),
			...(mounted.route ? { route: mounted.route } : {}),
			identity,
			visible: (principalId) => sockets.anyVisible(principalId),
			preview: options.push.preview,
			...(quiet ? { quiet } : {}),
			muted: async (room) => {
				const named = roomOf(room as ChannelKey, [options.surface]);
				// A temp knight's answers reach its knight's room, which pushes; its own room stays quiet.
				if (
					named?.kind === "agent" &&
					isHelper(agents.directory.agent(named.name))
				)
					return true;
				return held(room);
			},
			urlOf: options.push.urlOf,
			logger,
		});
		this.#mounted = mounted;
		this.#push = mounted.pushApi;
		const { registry } = options;
		sockets.setRoomReader((connection, room) =>
			registry.access.readNow(connection, room),
		);
		// An agent room's frames are the owners'; a host room's are its readers'.
		const audienceOf = (room: string): Audience =>
			registry.isHostRoom(room) ? { room } : { owners: true };
		// The desk starts a late answer's turn through the socket route, which is made after it.
		let route: SocketRoute | undefined;
		const desk = new OwnerDesk({
			broadcast: (frame, room) => sockets.deliver(frame, audienceOf(room)),
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
			audienceOf,
			isHostRoom: (room) => registry.isHostRoom(room),
			fileBinding: (room) => {
				const kind = registry.hostKindOf(room)?.kind;
				return {
					room,
					...(kind?.retention
						? { expiresAt: Date.now() + kind.retention.fileDays * 86_400_000 }
						: {}),
				};
			},
			channelContext: (message, contextOptions) =>
				hostApp?.channelContext(message, contextOptions) ??
				Promise.resolve(undefined),
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
			activity: (room) => {
				const round = surface.roundOf(room);
				return { ...surface.activityOf(room), ...(round ? { round } : {}) };
			},
			// The agent rooms are the owners'; where there are several, they can leave each other notes.
			readers: async () => (await identity.owners()).length > 1,
		});
		this.roomLayout = roomLayoutService({
			layout: new RoomLayout(options.database),
			surface: options.surface,
			directory: agents.directory,
			rooms,
			changed: options.changed,
		});
		hostApp = new HostApp({
			surface: options.surface,
			registry,
			sockets,
			app: surface,
			desk,
			log,
			cards: hostCards,
			reads,
			files: stored,
			uploads,
			rooms,
			conversations: options.conversations,
			nameOf,
			roomUrl: options.roomUrl,
			maxFileBytes: options.uploadMaxBytes,
			...(options.events ? { events: options.events } : {}),
			logger,
		});
		hostApp.install();
		this.#host = hostApp;
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
			blockAnswers: new BlockAnswering({ rooms, log, surface, logger }),
			uploads,
			presence,
			registry,
			gate: options.gate,
			audienceOf,
			opened: (connection) => mounted.opened(connection),
			// A knight that cannot be read must not keep the socket from opening.
			characterOf: (principalId) =>
				characters.of(principalId).catch((error: unknown) => {
					logger.warn({ err: error }, "a person's knight was not read");
					return undefined;
				}),
			conversations: options.conversations,
			logger,
		});
		const socketRoute = route;
		this.#unsubscribe.push(
			options.gate.onChanged((principalId) => socketRoute.refresh(principalId)),
		);
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
		postHelpersEnded(agents, surface, options.surface, logger);
		this.#api = new AppApi({
			...(options.presentation ? { presentation: options.presentation } : {}),
			...(options.timeZone ? { timeZone: options.timeZone } : {}),
			surface,
			rooms,
			log,
			cards,
			uploads,
			files: stored,
			modes,
			mutes,
			threads,
			layout: new RoomLayout(options.database),
			conversations: options.conversations,
			identity,
			...(options.schedules ? { schedules: options.schedules } : {}),
			...(options.workspace ? { workspace: options.workspace } : {}),
			directory: agents.directory,
			team: agents.team,
			...(options.skills ? { skills: options.skills } : {}),
			...(options.chatCommands ? { chatCommands: options.chatCommands } : {}),
			...(options.prompts ? { prompts: options.prompts } : {}),
			avatars: agents.avatars,
			reads,
			host: hostApp,
			nameOf,
			mount: options.mount,
			authMode: options.authMode,
			admission: options.admission,
			registry,
			gate: options.gate,
			pushTiers: options.pushTiers,
			modeSwitches: options.modeSwitches,
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
				sockets.deliver(
					{ type: "mode", room: channel, ...roomModeOf(mode) },
					{ owners: true },
				);
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

	/** Closes the sockets that came in on a session that has ended. */
	sessionEnded(id: string): void {
		this.#sockets.closeWhere(
			(connection) => connection.session === id,
			APP_CLOSE_EXPIRED,
			"expired",
		);
	}

	/** Tells the owners' sockets the team or the room list may differ, once changes settle. */
	changed(): void {
		if (this.#pending) return;
		this.#pending = setTimeout(() => {
			this.#pending = undefined;
			this.#sockets.deliver({ type: "changed" }, { owners: true });
		}, CHANGED_COALESCE_MS);
	}

	start(): void {
		this.#uploads.adopt();
		this.#host.start();
		this.#mounted.start();
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
		this.#host.stop();
		this.#mounted.stop().catch(() => undefined);
		this.#desk.stop();
		this.#presence.stop();
		this.#sockets.closeAll(1001, "stopping");
	}

	#sweep(): void {
		sweepApp(this.#uploads, this.#host, this.#options.logger);
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
		this.#sockets.deliver(
			{ type: "auto_approved", room, tool, action },
			{ owners: true },
		);
	}
}
