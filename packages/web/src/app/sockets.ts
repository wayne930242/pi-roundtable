import type { ActorFacts, Logger, RouteSocket, Tier } from "pi-roundtable";
import type { ServerFrame } from "../api-types.ts";

/** One open WebSocket: who, what the page shows, and when its credential lapses. */
export interface AppSocket {
	principal: { id: string; name: string };
	/** The actor the credential vouched for, which the person's messages are written as. */
	actor: ActorFacts | undefined;
	expiresAt: Date | undefined;
	/** The tier they hold, as of the upgrade or the latest frame or recheck. */
	tier: Tier;
	/** The identity they spoke as; the principal's id when the credential names none. */
	speakerId: string;
	/** The roles their sign-in carried. */
	roles: readonly string[];
	/** A required onboarding step stands undone: only the frames a gated socket may have reach it. */
	gated: boolean;
	/** The session the socket came in on, for the recheck that asks whether it still stands. */
	session?: string | undefined;
	/** The page is in view; a push goes out only when no socket is. */
	visible: boolean;
	/** The room the page shows, whose progress streams to it. */
	focus: string | undefined;
	/** The host rooms the socket follows. */
	subscriptions: Set<string>;
	/** Set once `ready` and the replay went out: until then nothing but a frame addressed to the socket reaches it. */
	started?: boolean;
	socket?: RouteSocket<AppSocket>;
	/** Closes the socket when its credential lapses or the cap on its life is reached. */
	expiry?: ReturnType<typeof setTimeout>;
	/** Looks again at whether the person is still admitted, and at which tier. */
	recheck?: ReturnType<typeof setInterval>;
}

/**
 * Who a frame is for. There is no unaddressed send: every frame names its audience, and the
 * open-time replay goes through the same filter as a live frame.
 */
export type Audience =
	/** Sockets whose tier is owner now; with `focus`, those showing that room. */
	| { owners: true; focus?: string }
	/** Every socket of one person. */
	| { principal: string }
	/** The sockets that follow a host room and may read it now; with `focus`, those also showing it. */
	| { room: string; focus?: true }
	/** One socket; with `audience`, only if it is also in that audience (the replay on open). */
	| { connection: AppSocket; audience?: Audience };

/** The frames a gated socket still gets: the gate itself, the person's notices and badge, and refusals. */
const GATED_FRAMES: ReadonlySet<ServerFrame["type"]> = new Set([
	"ready",
	"refused",
	"gate",
	"notice",
	"notice_resolved",
	"badge",
]);

/** Whether a socket may read a host room now; answered from a memo, so it costs no lookup. */
export type RoomReader = (connection: AppSocket, room: string) => boolean;

/** The open sockets, and the one way to put a frame on them. */
export class Sockets {
	readonly #open = new Set<AppSocket>();
	readonly #logger: Logger;
	#reader: RoomReader = () => false;

	constructor(logger: Logger) {
		this.#logger = logger;
	}

	/** Sets who may read which host room; until it is set, no host room frame reaches anyone. */
	setRoomReader(reader: RoomReader): void {
		this.#reader = reader;
	}

	add(connection: AppSocket, socket: RouteSocket<AppSocket>): void {
		connection.socket = socket;
		this.#open.add(connection);
	}

	remove(connection: AppSocket): void {
		clearTimeout(connection.expiry);
		connection.expiry = undefined;
		clearInterval(connection.recheck);
		connection.recheck = undefined;
		this.#open.delete(connection);
	}

	/** Whether the connection is in the audience now. */
	reaches(connection: AppSocket, audience: Audience): boolean {
		if ("connection" in audience)
			return (
				audience.connection === connection &&
				(!audience.audience || this.reaches(connection, audience.audience))
			);
		if (!connection.started) return false;
		if ("owners" in audience)
			return (
				connection.tier === "owner" &&
				(audience.focus === undefined || connection.focus === audience.focus)
			);
		if ("principal" in audience)
			return connection.principal.id === audience.principal;
		return (
			connection.subscriptions.has(audience.room) &&
			this.#reader(connection, audience.room) &&
			(!audience.focus || connection.focus === audience.room)
		);
	}

	/**
	 * Puts a frame on the sockets in `audience`, except `except`. A gated socket gets only what the
	 * gate lets through. A dropped send is logged, never thrown.
	 */
	deliver(frame: ServerFrame, audience: Audience, except?: AppSocket): void {
		for (const connection of this.#open) {
			if (connection === except || !this.reaches(connection, audience))
				continue;
			if (connection.gated && !GATED_FRAMES.has(frame.type)) continue;
			this.#send(connection, frame);
		}
	}

	#send(connection: AppSocket, frame: ServerFrame): void {
		const result = connection.socket?.send(JSON.stringify(frame));
		if (result === "dropped")
			this.#logger.warn(
				{ frame: frame.type },
				"an app frame was dropped; the socket is closed",
			);
	}

	/** Whether a page of this person is in view now; of any person when none is named. */
	anyVisible(principalId?: string): boolean {
		for (const connection of this.#open)
			if (
				connection.visible &&
				(principalId === undefined || connection.principal.id === principalId)
			)
				return true;
		return false;
	}

	/** Calls `visit` on each open socket `where` accepts. */
	each(
		where: (connection: AppSocket) => boolean,
		visit: (connection: AppSocket) => void,
	): void {
		for (const connection of [...this.#open])
			if (where(connection)) visit(connection);
	}

	/** Closes the sockets `where` accepts, such as those of a session that ended. */
	closeWhere(
		where: (connection: AppSocket) => boolean,
		code: number,
		reason: string,
	): void {
		for (const connection of [...this.#open])
			if (where(connection)) connection.socket?.close(code, reason);
	}

	/** Closes every socket, when the app stops. */
	closeAll(code: number, reason: string): void {
		this.closeWhere(() => true, code, reason);
	}

	get size(): number {
		return this.#open.size;
	}
}
