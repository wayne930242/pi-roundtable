import type {
	ChannelKey,
	RouteSocket,
	WebSocketAccept,
	WebSocketRoute,
} from "pi-roundtable";
import {
	APP_CLOSE_EXPIRED,
	APP_CLOSE_FORBIDDEN,
	APP_PROTOCOL,
	APP_PROTOCOL_VERSION,
	type ClientFrame,
	MAX_MESSAGE_FILES,
	type RefusalCode,
	type RoomFile,
	type RoomMessage,
} from "../api-types.ts";
import type { PluggedFrames } from "../web-app.ts";
import type { Answerer } from "./desk.ts";
import { parseClientFrame } from "./protocol.ts";
import { changeQueued } from "./queued-frames.ts";
import { say } from "./say.ts";
import { answerCard } from "./socket-cards.ts";
import {
	MAX_FRAME_BYTES,
	MAX_SOCKETS,
	MAX_TIMER_MS,
	RECHECK_MS,
	type SocketRouteOptions,
	viewerOfSocket,
} from "./socket-options.ts";
import { sendMessage } from "./socket-send.ts";
import type { AppSocket } from "./sockets.ts";

export { type SocketRouteOptions, viewerOfSocket } from "./socket-options.ts";

/**
 * The WebSocket of the app: the upgrade passes the console's authenticator, so it is the same
 * check as a page's and the API's, and every frame after it asks again whether the person is still
 * admitted and at which tier (a person who is not is refused and the socket closed). A frame is
 * answered with a frame; a refused one says why, and nothing a client names is taken on trust: a
 * room must be one of the app's and readable by the person, an upload must be the sender's own, a
 * card must be open and answerable by them. What a socket receives is addressed: see `Audience`.
 */
export class SocketRoute {
	readonly #options: SocketRouteOptions;
	readonly #now: () => number;
	/** The steps each socket was last told it owes, so a change of them is announced. */
	readonly #owed = new WeakMap<AppSocket, string>();

	constructor(options: SocketRouteOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	route(): WebSocketRoute<AppSocket> {
		return {
			origins: [this.#options.origin],
			maxConnections: MAX_SOCKETS,
			maxMessageBytes: MAX_FRAME_BYTES,
			maxBufferedBytes: 4 * 1024 * 1024,
			rate: { messages: 600, perMs: 60_000 },
			accept: (request) => this.#accept(request),
			open: (socket) => this.#open(socket),
			message: (socket, message) => this.#message(socket, message),
			close: (socket) => this.#options.sockets.remove(socket.data),
		};
	}

	async #accept(request: Request): Promise<WebSocketAccept<AppSocket>> {
		if (URL.parse(request.url)?.pathname !== this.#options.path)
			return new Response("Not Found", { status: 404 });
		const offered = (request.headers.get("sec-websocket-protocol") ?? "")
			.split(",")
			.map((value) => value.trim());
		if (!offered.includes(APP_PROTOCOL))
			return new Response(`Offer the ${APP_PROTOCOL} subprotocol`, {
				status: 400,
			});
		const admission = await this.#options.authenticator.authenticate(request);
		if ("refusal" in admission) {
			this.#options.logger.info(
				{ refusal: admission.refusal },
				"an app socket was refused",
			);
			return new Response(
				admission.status === 401 ? "Unauthorized" : "Forbidden",
				{ status: admission.status },
			);
		}
		const { visitor } = admission;
		const { principal } = visitor;
		return {
			data: {
				principal: { id: principal.id, name: principal.displayName },
				actor: admission.actor,
				expiresAt: admission.expiresAt,
				tier: visitor.tier,
				speakerId: visitor.speakerId,
				roles: visitor.roles,
				gated: false,
				session: admission.session,
				visible: false,
				focus: undefined,
				subscriptions: new Set<string>(),
			},
			headers: { "Sec-WebSocket-Protocol": APP_PROTOCOL },
		};
	}

	#open(socket: RouteSocket<AppSocket>): void {
		const connection = socket.data;
		const { sockets } = this.#options;
		sockets.add(connection, socket);
		const now = this.#now();
		const lapses = [
			connection.expiresAt?.getTime(),
			this.#options.maxLifeMs === undefined
				? undefined
				: now + this.#options.maxLifeMs,
		].filter((at): at is number => at !== undefined);
		if (lapses.length > 0) {
			const wait = Math.min(...lapses) - now;
			if (wait <= 0) {
				socket.close(APP_CLOSE_EXPIRED, "expired");
				return;
			}
			connection.expiry = setTimeout(
				() => socket.close(APP_CLOSE_EXPIRED, "expired"),
				Math.min(wait, MAX_TIMER_MS),
			);
		}
		connection.recheck = setInterval(() => {
			this.#state(connection).catch((error: unknown) =>
				this.#options.logger.warn(
					{ err: error },
					"an app socket's person was not looked up",
				),
			);
		}, this.#options.recheckMs ?? RECHECK_MS);
		this.#begin(connection).catch((error: unknown) => {
			this.#options.logger.warn({ err: error }, "an app socket did not start");
			socket.close(APP_CLOSE_FORBIDDEN, "forbidden");
		});
	}

	/**
	 * Admits the socket again, reads its gate, and sends `ready`. Until it has, no frame but ones
	 * addressed to the socket reach it, so nothing overtakes `ready`.
	 */
	async #begin(connection: AppSocket): Promise<void> {
		const { sockets, uploads, characterOf } = this.#options;
		const who = await this.#state(connection, { announce: false });
		if (!who) return;
		const owed = connection.gated ? await this.#steps(connection) : [];
		const character = await characterOf?.(connection.principal.id);
		sockets.deliver(
			{
				type: "ready",
				protocol: APP_PROTOCOL_VERSION,
				principal: connection.principal.id,
				name: connection.principal.name,
				...(character ? { character } : {}),
				uploads: {
					perMessage: MAX_MESSAGE_FILES,
					maxBytes: uploads.maxBytes,
				},
				...(owed.length > 0 ? { gate: owed } : {}),
			},
			{ connection },
		);
		// The socket is started before the hook runs, so the frames it sends reach the socket.
		connection.started = true;
		await this.#options
			.opened?.(connection)
			.catch((error: unknown) =>
				this.#options.logger.warn(
					{ err: error },
					"an app socket was not given its notices",
				),
			);
		if (connection.gated) return;
		this.#replay(connection);
	}

	/** Sends a socket the open cards it may have and the table of who is busy, and starts its live frames. */
	#replay(connection: AppSocket): void {
		const { sockets, desk, presence, audienceOf } = this.#options;
		// The replay goes through the same audience filter as a live frame, which needs the socket started.
		connection.started = true;
		for (const { room, frame } of desk.openFrames())
			sockets.deliver(frame, {
				connection,
				audience: audienceOf(room),
			});
		presence?.frame().then(
			(frame) =>
				sockets.deliver(frame, {
					connection,
					audience: { owners: true },
				}),
			(error: unknown) =>
				this.#options.logger.warn({ err: error }, "presence was not sent"),
		);
	}

	async #steps(connection: AppSocket) {
		return this.#options.gate.required(viewerOfSocket(connection));
	}

	/**
	 * Asks again whether the person behind a socket is still admitted and at which tier, and
	 * whether a required step stands in the way. Loses the socket when they are not admitted; a
	 * change of tier or of the gate takes effect on what the socket is sent from here on.
	 */
	async #state(
		connection: AppSocket,
		options: { announce: boolean } = { announce: true },
	): Promise<Answerer | undefined> {
		const { authenticator, sockets, gate } = this.#options;
		const checked = await authenticator.recheck({
			actor: connection.actor,
			session: connection.session,
		});
		if ("refusal" in checked) {
			connection.socket?.close(
				checked.status === 401 ? APP_CLOSE_EXPIRED : APP_CLOSE_FORBIDDEN,
				checked.status === 401 ? "expired" : "forbidden",
			);
			return undefined;
		}
		const { visitor } = checked;
		connection.tier = visitor.tier;
		connection.roles = visitor.roles;
		connection.speakerId = visitor.speakerId;
		connection.principal.name = visitor.principal.displayName;
		// A page the person may not show is not shown: a focus on an agent room is the owners'.
		if (
			connection.focus !== undefined &&
			!this.#mayFocus(connection, connection.focus)
		)
			connection.focus = undefined;
		const steps = await gate.required(viewerOfSocket(connection));
		const gated = steps.length > 0;
		// A change of which steps are owed is announced too, not only a change of whether any is.
		const owed = steps.map((step) => step.id).join(",");
		const listChanged = owed !== this.#owed.get(connection);
		this.#owed.set(connection, owed);
		if (gated !== connection.gated || (gated && listChanged)) {
			const opens = connection.gated && !gated;
			connection.gated = gated;
			if (options.announce) {
				sockets.deliver({ type: "gate", steps }, { connection });
				if (opens) this.#replay(connection);
			}
		}
		return {
			principalId: connection.principal.id,
			tier: connection.tier,
			speakerId: connection.speakerId,
			name: connection.principal.name,
			roles: connection.roles,
			...(connection.actor ? { actor: connection.actor } : {}),
		};
	}

	/** Tells every open socket of a person what they now owe; the gate calls it when their steps change. */
	refresh(principalId: string): void {
		this.#options.sockets.each(
			(c) => c.principal.id === principalId,
			(c) => {
				this.#state(c).catch((error: unknown) =>
					this.#options.logger.warn({ err: error }, "a gate was not read"),
				);
			},
		);
	}

	/** Whether a socket may show a room: an agent room to an owner, a host room it follows. */
	#mayFocus(connection: AppSocket, room: string): boolean {
		return this.#options.registry.isHostRoom(room)
			? connection.subscriptions.has(room)
			: connection.tier === "owner";
	}

	#refuse(
		connection: AppSocket,
		code: RefusalCode,
		id?: string,
		prompt?: string,
	): void {
		this.#options.sockets.deliver(
			{
				type: "refused",
				code,
				...(id === undefined ? {} : { id }),
				...(prompt === undefined ? {} : { prompt }),
			},
			{ connection },
		);
	}

	async #message(
		socket: RouteSocket<AppSocket>,
		raw: string | Uint8Array,
	): Promise<void> {
		const connection = socket.data;
		const frame = parseClientFrame(raw);
		if (!frame) {
			this.#refuse(connection, "bad_frame");
			return;
		}
		// What a socket shows applies the moment its frame arrives: the lookup below awaits, and
		// frames that waited on it could land out of order.
		switch (frame.type) {
			case "hello":
				connection.visible = frame.visible;
				connection.focus =
					frame.focus !== undefined && this.#mayFocus(connection, frame.focus)
						? frame.focus
						: undefined;
				break;
			case "visibility":
				connection.visible = frame.visible;
				break;
			case "focus":
				connection.focus =
					frame.room !== undefined && this.#mayFocus(connection, frame.room)
						? frame.room
						: undefined;
				break;
			default:
				break;
		}
		// Every frame comes from a person admitted now, at the tier they hold now; a socket whose
		// person is no longer admitted is closed rather than left to receive what the room's readers are shown.
		const who = await this.#state(connection);
		if (!who) {
			this.#refuse(
				connection,
				"forbidden",
				"id" in frame ? frame.id : undefined,
			);
			return;
		}
		if (
			frame.type === "hello" ||
			frame.type === "visibility" ||
			frame.type === "focus"
		)
			return;
		// While a required step stands undone a socket may only handle notices.
		if (connection.gated && frame.type !== "ack") {
			this.#refuse(connection, "gated", "id" in frame ? frame.id : undefined);
			return;
		}
		await this.#write(connection, who, frame);
	}

	async #write(
		connection: AppSocket,
		who: Answerer,
		frame: Exclude<ClientFrame, { type: "hello" | "visibility" | "focus" }>,
	): Promise<void> {
		const { rooms, conversations, registry } = this.#options;
		let refused: RefusalCode | undefined;
		switch (frame.type) {
			case "send":
				if (registry.isHostRoom(frame.room)) {
					await this.#plugged(connection, "hostSend", frame);
					return;
				}
				await sendMessage(this.#options, connection, who, frame, (code) =>
					this.#refuse(connection, code, frame.id),
				);
				return;
			case "stop": {
				if (registry.isHostRoom(frame.room)) {
					await this.#plugged(connection, "hostStop", frame);
					return;
				}
				// The agent rooms are the owners'.
				if (who.tier !== "owner") {
					refused = "forbidden";
					break;
				}
				const room = await rooms.resolve(frame.room);
				if (!room || room.readOnly) refused = "unknown_room";
				else conversations.stop(room.key);
				break;
			}
			case "block_answer":
				await this.#blockAnswer(connection, who, frame);
				return;
			case "edit_queued":
			case "cancel_queued":
				refused = await changeQueued(frame, who, {
					rooms,
					surface: this.#options.surface,
					conversations,
				});
				break;
			case "approval":
			case "answer":
			case "answers":
			case "cancel":
				refused = await answerCard(this.#options, who, frame);
				break;
			case "subscribe":
			case "unsubscribe":
			case "act":
			case "ack":
			case "read":
				await this.#plugged(connection, frame.type, frame);
				return;
		}
		if (refused)
			this.#refuse(
				connection,
				refused,
				undefined,
				"prompt" in frame ? frame.prompt : undefined,
			);
	}

	/** Hands a frame to the piece of the app that handles it; a frame nobody handles is refused. */
	async #plugged<K extends keyof PluggedFrames>(
		connection: AppSocket,
		type: K,
		frame: PluggedFrames[K],
	): Promise<void> {
		const handler = this.#options.registry.frameHandler(type);
		const id = "id" in frame ? frame.id : undefined;
		if (!handler) {
			this.#refuse(connection, "unknown_room", id);
			return;
		}
		try {
			await handler({
				frame,
				viewer: viewerOfSocket(connection),
				connection,
				refuse: (code, ref) => this.#refuse(connection, code, ref ?? id),
			});
		} catch (error) {
			this.#options.logger.warn(
				{ frame: type, err: error },
				"an app frame was not handled",
			);
			this.#refuse(connection, "not_accepted", id);
		}
	}

	/**
	 * An owner's answer to a block: sent to the agent as the owner's next message, by the path a
	 * typed message takes, so it steers into a running turn, queues or starts one. The sender hears
	 * the message that carries it, or why none was sent; the other sockets see the block locked.
	 */
	async #blockAnswer(
		connection: AppSocket,
		who: Answerer,
		frame: Extract<ClientFrame, { type: "block_answer" }>,
	): Promise<void> {
		const { id, room, message, block } = frame;
		const outcome = await this.#options.blockAnswers.answer(
			frame,
			who,
			(key, text, stored) => this.say(key, who, text, [], connection, stored),
		);
		this.#options.sockets.deliver(
			outcome.ok
				? { type: "accepted", id, room, message: outcome.message }
				: {
						type: "block_refused",
						id,
						room,
						message,
						block,
						code: outcome.code,
						...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
						...(outcome.fields === undefined ? {} : { fields: outcome.fields }),
					},
			{ connection },
		);
	}

	/** Takes a message of the owner into a room; see `say`. */
	say(
		room: ChannelKey,
		who: Answerer,
		text: string,
		files: readonly RoomFile[],
		except?: AppSocket,
		stored?: (message: RoomMessage) => void | Promise<void>,
	): Promise<void> {
		return say(this.#options, room, who, text, files, except, stored);
	}
}
