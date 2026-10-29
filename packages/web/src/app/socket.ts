import type {
	ChannelKey,
	ConversationPort,
	InboundMessage,
	Logger,
	RouteSocket,
	WebSocketAccept,
	WebSocketRoute,
} from "pi-roundtable";
import { PluginError } from "pi-roundtable";
import {
	APP_CLOSE_EXPIRED,
	APP_CLOSE_FORBIDDEN,
	APP_PROTOCOL,
	APP_PROTOCOL_VERSION,
	type ClientFrame,
	MAX_MESSAGE_CHARS,
	MAX_MESSAGE_FILES,
	type RefusalCode,
	type RoomFile,
	type RoomMessage,
} from "../api-types.ts";
import type { Authenticator } from "../auth/authenticator.ts";
import type { Gate } from "../gate.ts";
import type { PluggedFrames, Viewer, WebAppRegistry } from "../web-app.ts";
import type { Answerer, OwnerDesk } from "./desk.ts";
import type { Presence } from "./presence.ts";
import { parseClientFrame } from "./protocol.ts";
import type { Rooms } from "./rooms.ts";
import type { AppSocket, Audience, Sockets } from "./sockets.ts";
import type { AppSurface } from "./surface.ts";
import type { Uploads } from "./uploads.ts";

/** The longest delay a timer keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The most sockets the route holds open at once. */
const MAX_SOCKETS = 32;
/** How often an open socket's person is looked up again, when the options say nothing else. */
const RECHECK_MS = 30_000;
/** The largest frame in bytes; a `send` carries text only, so this is far above `MAX_MESSAGE_CHARS`. */
const MAX_FRAME_BYTES = 192 * 1024;

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
	conversations: Pick<ConversationPort, "stop">;
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
		const { sockets, uploads } = this.#options;
		const who = await this.#state(connection, { announce: false });
		if (!who) return;
		const owed = connection.gated ? await this.#steps(connection) : [];
		sockets.deliver(
			{
				type: "ready",
				protocol: APP_PROTOCOL_VERSION,
				principal: connection.principal.id,
				name: connection.principal.name,
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
		if (gated !== connection.gated) {
			connection.gated = gated;
			if (options.announce) {
				sockets.deliver({ type: "gate", steps }, { connection });
				if (!gated) this.#replay(connection);
			}
		}
		return {
			principalId: connection.principal.id,
			tier: connection.tier,
			speakerId: connection.speakerId,
			name: connection.principal.name,
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
				frame.type === "send" ? frame.id : undefined,
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
			this.#refuse(
				connection,
				"gated",
				frame.type === "send" || frame.type === "act" ? frame.id : undefined,
			);
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
				await this.#send(connection, who, frame);
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
			case "approval":
			case "answer":
			case "answers":
			case "cancel":
				refused = await this.#card(who, frame);
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
	 * An answer to a card: who may give it is the card's own audience (the turn's speaker, the
	 * named approvers, the owners where the scope escalates), which the room's access cannot widen.
	 * A card of a host room is first something the person must be able to read; a card of an agent
	 * room is the owners'.
	 */
	async #card(
		who: Answerer,
		frame: Extract<
			ClientFrame,
			{ type: "approval" | "answer" | "answers" | "cancel" }
		>,
	): Promise<RefusalCode | undefined> {
		const { desk, registry } = this.#options;
		const room = desk.roomOf(frame.prompt);
		if (room !== undefined) {
			if (registry.isHostRoom(room)) {
				const viewer: Viewer = {
					principalId: who.principalId,
					speakerId: who.speakerId,
					tier: who.tier,
					roles: [],
					name: who.name,
				};
				if (!(await registry.access.read(viewer, room as ChannelKey)))
					return "unknown_prompt";
			} else if (who.tier !== "owner") return "forbidden";
		}
		switch (frame.type) {
			case "approval":
				return this.#needsActor(who, frame.prompt)
					? "forbidden"
					: desk.approve(who, frame.prompt, frame.approved);
			case "answer":
				return this.#needsActor(who, frame.prompt)
					? "forbidden"
					: desk.answer(who, frame.prompt, frame.answer);
			case "answers":
				return this.#needsActor(who, frame.prompt)
					? "forbidden"
					: desk.answers(who, frame.prompt, frame.answers, frame.note);
			case "cancel":
				return desk.cancel(who, frame.prompt);
		}
	}

	/**
	 * Whether this answer cannot be taken: a late card's answer starts a turn written as the
	 * answerer, which needs the actor their credential vouched for. Refused up front, the card
	 * stays open for someone who has one rather than closing on an answer that goes nowhere.
	 */
	#needsActor(who: Answerer, prompt: string): boolean {
		return !who.actor && this.#options.desk.isLate(prompt);
	}

	async #send(
		connection: AppSocket,
		who: Answerer,
		frame: Extract<ClientFrame, { type: "send" }>,
	): Promise<void> {
		const { rooms, uploads, surface, sockets, logger } = this.#options;
		const refuse = (code: RefusalCode) =>
			this.#refuse(connection, code, frame.id);
		// The agent rooms are the owners', and they take only turns.
		if (who.tier !== "owner") return refuse("forbidden");
		if (frame.mode === "note") return refuse("bad_frame");
		const room = await rooms.resolve(frame.room);
		if (!room) return refuse("unknown_room");
		if (room.readOnly) return refuse("read_only");
		const text = frame.text.trim();
		if (text.length > MAX_MESSAGE_CHARS) return refuse("too_long");
		const ids = frame.uploads ?? [];
		if (text === "" && ids.length === 0) return refuse("empty");
		// Without the actor the credential vouched for, the router cannot tell whose message it is.
		if (!who.actor) return refuse("forbidden");
		const files = uploads.claim(ids, who.principalId);
		if (!files) return refuse("unknown_upload");
		if (!surface.started) return refuse("not_accepted");
		try {
			await this.say(room.key, who, text, files, connection, (message) =>
				sockets.deliver(
					{ type: "accepted", id: frame.id, room: room.key, message },
					{ connection },
				),
			);
		} catch (error) {
			logger.warn(
				{ room: room.key, err: error },
				"an app message was not taken",
			);
			refuse("not_accepted");
		}
	}

	/**
	 * Takes a message of the owner into a room: stores it, shows it to the other sockets, and
	 * hands it to the host as the owner's. `files` are uploads the sender claimed, which move to
	 * the stored files once the message is stored. `stored` hears the stored message before the
	 * host does, so a reply cannot overtake it.
	 */
	async say(
		room: ChannelKey,
		who: Answerer,
		text: string,
		files: readonly RoomFile[],
		except?: AppSocket,
		stored?: (message: RoomMessage) => void,
	): Promise<void> {
		const { surface, uploads } = this.#options;
		if (!who.actor)
			throw new PluginError(
				"a message needs the actor its sender's credential vouched for",
			);
		const message = await surface.publish(
			{
				room,
				kind: "owner",
				principalId: who.principalId,
				author: who.name,
				text,
				files: [...files],
			},
			except,
		);
		uploads.use(files.map((file) => file.id));
		stored?.(message);
		const inbound: InboundMessage = {
			channel: room,
			messageId: `app-${message.id}`,
			actor: who.actor,
			authorId: who.principalId,
			authorName: who.name,
			authorIsBot: false,
			isDirect: false,
			mentionsBot: false,
			repliesToBot: false,
			text,
			attachments: files.map((file) => uploads.refOf(file)),
		};
		surface.deliver(inbound);
	}
}
