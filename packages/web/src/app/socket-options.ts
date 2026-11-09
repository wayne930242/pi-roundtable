import type { ConversationPort, Logger } from "pi-roundtable";
import type { Authenticator } from "../auth/authenticator.ts";
import type { Gate } from "../gate.ts";
import type { Viewer, WebAppRegistry } from "../web-app.ts";
import type { BlockAnswering } from "./block-answering.ts";
import type { OwnerDesk } from "./desk.ts";
import type { Presence } from "./presence.ts";
import type { Rooms } from "./rooms.ts";
import type { AppSocket, Audience, Sockets } from "./sockets.ts";
import type { AppSurface } from "./surface.ts";
import type { Uploads } from "./uploads.ts";

/** The longest delay a timer keeps; a longer one fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** The most sockets the route holds open at once. */
export const MAX_SOCKETS = 32;
/** How often an open socket's person is looked up again, when the options say nothing else. */
export const RECHECK_MS = 30_000;
/** The largest frame in bytes; a `send` carries text only, so this is far above `MAX_MESSAGE_CHARS`. */
export const MAX_FRAME_BYTES = 192 * 1024;

export interface SocketRouteOptions {
	/** The path of the socket: `<mount>/api/socket`. */
	path: string;
	/** The console's own origin, the only one a browser may open the socket from. */
	origin: string;
	authenticator: Pick<Authenticator, "authenticate" | "recheck">;
	sockets: Sockets;
	surface: AppSurface;
	desk: OwnerDesk;
	rooms: Rooms;
	/** Takes an owner's answer to an interactive block of an agent's reply. */
	blockAnswers: Pick<BlockAnswering, "answer">;
	/** The table of who is busy, sent to the owners after `ready`; absent in a route built without one. */
	presence?: Pick<Presence, "frame">;
	uploads: Uploads;
	/** What the pieces of the app plug in: host rooms, their frame handlers and the rule for who reads them. */
	registry: Pick<WebAppRegistry, "frameHandler" | "isHostRoom" | "access">;
	/** The onboarding gate: a socket whose person owes a required step is gated. */
	gate: Pick<Gate, "required" | "onChanged">;
	/** Who has a room's frames. */
	audienceOf(room: string): Audience;
	/**
	 * Called once the socket has had `ready` and before anything else is replayed to it, gated or
	 * not: the pieces of the app send what is per person there, such as the notices and the badge.
	 */
	opened?(connection: AppSocket): Promise<void>;
	conversations: Pick<ConversationPort, "stop" | "cancelQueued" | "editQueued">;
	logger: Logger;
	/**
	 * The longest a socket stays open, whatever its credential says. A password session lives for
	 * days and a logout or a new password does not reach an open socket, so the socket is closed
	 * with 4401 after this long and its reconnect carries the cookie again. Absent: no cap.
	 */
	maxLifeMs?: number;
	/** How often an open socket's person is looked up again; default 30 s. */
	recheckMs?: number;
	/** The clock, in milliseconds; default `Date.now`. */
	now?: () => number;
}

/** The viewer behind a socket, at the tier it holds now. */
export const viewerOfSocket = (connection: AppSocket): Viewer => ({
	principalId: connection.principal.id,
	speakerId: connection.speakerId,
	tier: connection.tier,
	roles: connection.roles,
	name: connection.principal.name,
});
