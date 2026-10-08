import type { Logger, RouteSocket, Speaker } from "pi-roundtable";
import type { WebIdentity } from "./oidc.ts";
import type { ServerFrame } from "./protocol.ts";

/** One authenticated WebSocket: who it is, at which tier, until when its token holds. */
export interface Connection {
	identity: WebIdentity;
	speaker: Speaker;
	socket?: RouteSocket<Connection>;
	/** Asks for a fresh token, then closes the socket when the token expires. */
	timers: ReturnType<typeof setTimeout>[];
	/** Releases the place a refused or never-opened upgrade held. */
	pending?: ReturnType<typeof setTimeout>;
	/** Whether the connection holds one of its person's places. */
	holding?: boolean;
}

/** How long an accepted upgrade may take to open before its place is released. */
const OPEN_WITHIN_MS = 10_000;

/**
 * The open WebSocket connections, by person. Each person holds at most `perPrincipal` at once,
 * counting the upgrades still opening, so one account cannot take every place of the route.
 */
export class Connections {
	readonly #byPrincipal = new Map<string, Set<Connection>>();
	readonly #held = new Map<string, number>();
	readonly #perPrincipal: number;
	readonly #logger: Logger;

	constructor(options: { perPrincipal: number; logger: Logger }) {
		this.#perPrincipal = options.perPrincipal;
		this.#logger = options.logger;
	}

	/** Takes a place for an upgrade that is about to open; false when the person holds every place. */
	reserve(connection: Connection): boolean {
		const id = connection.speaker.principalId;
		const held = this.#held.get(id) ?? 0;
		if (held >= this.#perPrincipal) return false;
		this.#held.set(id, held + 1);
		connection.holding = true;
		connection.pending = setTimeout(
			() => this.#release(connection),
			OPEN_WITHIN_MS,
		);
		return true;
	}

	/** Counts an open socket; false when its upgrade took so long that its place was released. */
	opened(connection: Connection, socket: RouteSocket<Connection>): boolean {
		if (!connection.holding) return false;
		clearTimeout(connection.pending);
		connection.pending = undefined;
		connection.socket = socket;
		const id = connection.speaker.principalId;
		const set = this.#byPrincipal.get(id) ?? new Set();
		set.add(connection);
		this.#byPrincipal.set(id, set);
		return true;
	}

	closed(connection: Connection): void {
		for (const timer of connection.timers) clearTimeout(timer);
		connection.timers = [];
		const id = connection.speaker.principalId;
		const set = this.#byPrincipal.get(id);
		set?.delete(connection);
		if (set?.size === 0) this.#byPrincipal.delete(id);
		this.#release(connection);
	}

	#release(connection: Connection): void {
		clearTimeout(connection.pending);
		connection.pending = undefined;
		if (!connection.holding) return;
		connection.holding = false;
		const id = connection.speaker.principalId;
		const held = (this.#held.get(id) ?? 1) - 1;
		if (held > 0) this.#held.set(id, held);
		else this.#held.delete(id);
	}

	/** Sends a frame on one connection; a dropped send is logged, never thrown. */
	send(connection: Connection, frame: ServerFrame): void {
		const result = connection.socket?.send(JSON.stringify(frame));
		if (result === "dropped")
			this.#logger.warn(
				{ frame: frame.type },
				"a web chat frame was dropped; the connection is closed",
			);
	}

	/** Sends a frame to every connection of a person; none open is not an error. */
	sendTo(principal: string, frame: ServerFrame): void {
		for (const connection of this.#byPrincipal.get(principal) ?? [])
			this.send(connection, frame);
	}
}
