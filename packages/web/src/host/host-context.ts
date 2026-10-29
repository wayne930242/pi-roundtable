import type {
	ChannelKey,
	ConversationPort,
	EventSink,
	Logger,
} from "pi-roundtable";
import type { OwnerDesk } from "../app/desk.ts";
import type { FileDir } from "../app/files.ts";
import type { RoomLog } from "../app/room-log.ts";
import type { Rooms } from "../app/rooms.ts";
import type { Sockets } from "../app/sockets.ts";
import type { AppSurface } from "../app/surface.ts";
import type { Uploads } from "../app/uploads.ts";
import type { WebAppRegistry } from "../web-app.ts";
import type { HostAccess } from "./access.ts";
import type { HostCardLog } from "./cards.ts";
import type { HostPagesService } from "./pages.ts";
import type { RoomReads } from "./reads.ts";
import type { ListedKinds } from "./rooms-service.ts";

/** Everything the pieces of the host rooms share. */
export interface HostContext {
	/** The key prefix of the app's rooms: `app`. */
	surface: string;
	registry: WebAppRegistry;
	sockets: Sockets;
	app: AppSurface;
	desk: Pick<OwnerDesk, "openFrames" | "roomOf">;
	log: RoomLog;
	cards: HostCardLog;
	reads: RoomReads;
	/** The stored files. */
	files: FileDir;
	uploads: Uploads;
	/** The agent rooms, for the read marks of the owners. */
	rooms: Pick<Rooms, "resolve">;
	conversations: Pick<ConversationPort, "stop">;
	access: HostAccess;
	listed: ListedKinds;
	pages: Pick<HostPagesService, "act" | "view" | "visible">;
	/** The name the app shows for a person. */
	nameOf(principalId: string): Promise<string>;
	events: Pick<EventSink, "action"> | undefined;
	now(): number;
	logger: Logger;
}

/** A room key as the registry's `ChannelKey`. */
export const asRoom = (key: string): ChannelKey => key as ChannelKey;
