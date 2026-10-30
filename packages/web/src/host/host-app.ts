import type {
	ChannelKey,
	ConversationPort,
	EventSink,
	InboundMessage,
	Logger,
} from "pi-roundtable";
import type {
	ChannelContext,
	ChannelContextOptions,
} from "pi-roundtable/discord";
import type { OwnerDesk } from "../app/desk.ts";
import type { FileDir } from "../app/files.ts";
import type { RoomLog } from "../app/room-log.ts";
import type { Rooms } from "../app/rooms.ts";
import type { AppSocket, Sockets } from "../app/sockets.ts";
import type { AppSurface } from "../app/surface.ts";
import type { Uploads } from "../app/uploads.ts";
import type { Viewer, WebAppRegistry } from "../web-app.ts";
import { HostAccess } from "./access.ts";
import type { HostCardLog } from "./cards.ts";
import { type HostRoomContext, hostRoomContext } from "./context.ts";
import { installFrames } from "./frames.ts";
import type { HostContext } from "./host-context.ts";
import { hostArea, pagesArea } from "./host-routes.ts";
import { HostPagesService, PAGE_BINDING } from "./pages.ts";
import type { RoomReads } from "./reads.ts";
import { type HostSweep, sweepHostKinds } from "./retention.ts";
import { HostRoomsService, ListedKinds } from "./rooms-service.ts";

export interface HostAppOptions {
	surface: string;
	registry: WebAppRegistry;
	sockets: Sockets;
	app: AppSurface;
	desk: Pick<OwnerDesk, "openFrames" | "roomOf">;
	log: RoomLog;
	cards: HostCardLog;
	reads: RoomReads;
	files: FileDir;
	uploads: Uploads;
	rooms: Pick<Rooms, "resolve">;
	conversations: Pick<ConversationPort, "stop">;
	/** The name the app shows for a person. */
	nameOf(principalId: string): Promise<string>;
	/** The same-origin URL of a room, and of one of its messages. */
	roomUrl(room: ChannelKey, message?: number): string;
	/** The most bytes of one file a host saves. */
	maxFileBytes: number;
	events?: Pick<EventSink, "action">;
	now?: () => number;
	/** How long an answer of a kind's `access` is trusted; default 10 s. */
	accessTtlMs?: number;
	logger: Logger;
}

/**
 * The host rooms of the web app: what a host plugin registers through `WEB_APP` (kinds, pages) and
 * writes through it (`rooms`, `pages`), made real. It decides who reads a room, takes the frames
 * the page sends for host rooms and the REST under `api/host` and `api/pages`, keeps the room's
 * cards and read cursors, and applies the kinds' retention. The owner app creates one and calls
 * `install` once, before the web service starts.
 */
export class HostApp {
	readonly access: HostAccess;
	readonly rooms: HostRoomsService;
	readonly pages: HostPagesService;
	readonly #context: HostContext;
	readonly #roomContext: HostRoomContext;

	constructor(options: HostAppOptions) {
		const now = options.now ?? Date.now;
		const listed = new ListedKinds();
		this.access = new HostAccess({
			registry: options.registry,
			sockets: options.sockets,
			logger: options.logger,
			now,
			...(options.accessTtlMs === undefined
				? {}
				: { ttlMs: options.accessTtlMs }),
			// The person lost a room: their page is told to look again, which finds it gone.
			revoked: (connection: AppSocket, room: string) =>
				options.sockets.deliver({ type: "room_changed", room }, { connection }),
		});
		this.pages = new HostPagesService({
			registry: options.registry,
			sockets: options.sockets,
			files: options.files,
			maxFileBytes: options.maxFileBytes,
			events: options.events,
			now,
			logger: options.logger,
		});
		this.rooms = new HostRoomsService({
			registry: options.registry,
			sockets: options.sockets,
			log: options.log,
			cards: options.cards,
			files: options.files,
			access: this.access,
			maxFileBytes: options.maxFileBytes,
			roomUrl: options.roomUrl,
			listed,
			context: (room, contextOptions) =>
				this.#roomContext.peek(room, contextOptions),
			now,
			logger: options.logger,
		});
		this.#context = {
			surface: options.surface,
			registry: options.registry,
			sockets: options.sockets,
			app: options.app,
			desk: options.desk,
			log: options.log,
			cards: options.cards,
			reads: options.reads,
			files: options.files,
			uploads: options.uploads,
			rooms: options.rooms,
			conversations: options.conversations,
			access: this.access,
			listed,
			pages: this.pages,
			nameOf: options.nameOf,
			events: options.events,
			now,
			logger: options.logger,
		};
		this.#roomContext = hostRoomContext(this.#context);
	}

	/** Plugs the pieces into the registry: who reads, the frames, the areas, and the services a host reaches. */
	install(): void {
		const { registry } = this.#context;
		registry.setAccess(this.access);
		registry.provide({ rooms: this.rooms, pages: this.pages });
		installFrames(this.#context);
		registry.onArea(hostArea(this.#context));
		registry.onArea(pagesArea(this.#context));
	}

	start(): void {
		this.access.start();
	}

	stop(): void {
		this.access.stop();
		this.pages.stop();
	}

	/** What was said in a host room since the assistant last posted; undefined for any other room. */
	channelContext(
		message: InboundMessage,
		options?: ChannelContextOptions,
	): Promise<ChannelContext | undefined> {
		return this.#roomContext.read(message, options);
	}

	/** Whether a stored file bound to a room or a page may be served to this viewer now. */
	async mayRead(viewer: Viewer, binding: string): Promise<boolean> {
		if (binding.startsWith(PAGE_BINDING))
			return (
				(await this.pages.visible(
					viewer,
					binding.slice(PAGE_BINDING.length),
				)) !== undefined
			);
		if (!this.#context.registry.isHostRoom(binding)) return false;
		return this.access.read(viewer, binding as ChannelKey);
	}

	/** Applies the kinds' retention; the counts of what it removed. */
	sweep(): Promise<HostSweep> {
		return sweepHostKinds(this.#context);
	}
}
