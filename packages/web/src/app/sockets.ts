import type { ActorFacts, Logger, RouteSocket } from "pi-roundtable";
import type { ServerFrame } from "../api-types.ts";

/** One open WebSocket of an owner: who, what the page shows, and when its credential lapses. */
export interface AppSocket {
	principal: { id: string; name: string };
	/** The actor the credential vouched for, which the person's messages are written as. */
	actor: ActorFacts | undefined;
	expiresAt: Date | undefined;
	/** The page is in view; a push goes out only when no socket is. */
	visible: boolean;
	/** The room the page shows, whose progress streams to it. */
	focus: string | undefined;
	socket?: RouteSocket<AppSocket>;
	/** Closes the socket when its credential lapses or the cap on its life is reached. */
	expiry?: ReturnType<typeof setTimeout>;
	/** Looks again at whether the person is still an owner. */
	recheck?: ReturnType<typeof setInterval>;
}

/** The open sockets. Every one belongs to an owner, so a frame for the owners goes to them all. */
export class Sockets {
	readonly #open = new Set<AppSocket>();
	readonly #logger: Logger;

	constructor(logger: Logger) {
		this.#logger = logger;
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

	/** Sends a frame on one socket; a dropped send is logged, never thrown. */
	send(connection: AppSocket, frame: ServerFrame): void {
		const result = connection.socket?.send(JSON.stringify(frame));
		if (result === "dropped")
			this.#logger.warn(
				{ frame: frame.type },
				"an app frame was dropped; the socket is closed",
			);
	}

	/** Sends a frame to every open socket, or those `where` accepts, except `except`. */
	broadcast(
		frame: ServerFrame,
		where?: (connection: AppSocket) => boolean,
		except?: AppSocket,
	): void {
		for (const connection of this.#open)
			if (connection !== except && (!where || where(connection)))
				this.send(connection, frame);
	}

	/** Whether a page of this person is in view now; of any owner when no one is named. */
	anyVisible(principalId?: string): boolean {
		for (const connection of this.#open)
			if (
				connection.visible &&
				(principalId === undefined || connection.principal.id === principalId)
			)
				return true;
		return false;
	}

	/** Closes every socket, when the app stops. */
	closeAll(code: number, reason: string): void {
		for (const connection of [...this.#open])
			connection.socket?.close(code, reason);
	}

	get size(): number {
		return this.#open.size;
	}
}
