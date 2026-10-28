import type {
	ActorFacts,
	ChannelKey,
	ConversationPort,
	IdentityService,
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
import type { Answerer, OwnerDesk } from "./desk.ts";
import { parseClientFrame } from "./protocol.ts";
import type { Rooms } from "./rooms.ts";
import type { AppSocket, Sockets } from "./sockets.ts";
import type { AppSurface } from "./surface.ts";
import { UPLOAD_MAX_BYTES, UPLOAD_TYPES, type Uploads } from "./uploads.ts";

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
	authenticator: Pick<Authenticator, "authenticate">;
	sockets: Sockets;
	surface: AppSurface;
	desk: OwnerDesk;
	rooms: Rooms;
	uploads: Uploads;
	identity: Pick<IdentityService, "tierOf">;
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

/** The identity string a person's messages are written as: `<provider>:<subject>`. */
const identityOf = (actor: ActorFacts | undefined, fallback: string) =>
	actor ? `${actor.provider}:${actor.subject}` : fallback;

/**
 * The WebSocket of the owner app: the upgrade passes the console's authenticator, so it is the
 * same check as a page's and the API's, and every frame after it is a write by an owner whose
 * tier is read again. A frame is answered with a frame; a refused one says why, and nothing a
 * client names is taken on trust: a room must be one of the app's, an upload must be the
 * sender's own, a card must be open and answerable by them.
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
		const { principal } = admission.visitor;
		return {
			data: {
				principal: { id: principal.id, name: principal.displayName },
				actor: admission.actor,
				expiresAt: admission.expiresAt,
				visible: false,
				focus: undefined,
			},
			headers: { "Sec-WebSocket-Protocol": APP_PROTOCOL },
		};
	}

	#open(socket: RouteSocket<AppSocket>): void {
		const connection = socket.data;
		const { sockets, desk } = this.#options;
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
			this.#owner(connection).then(
				(who) => {
					if (!who) socket.close(APP_CLOSE_FORBIDDEN, "forbidden");
				},
				(error: unknown) =>
					this.#options.logger.warn(
						{ err: error },
						"an app socket's person was not looked up",
					),
			);
		}, this.#options.recheckMs ?? RECHECK_MS);
		sockets.send(connection, {
			type: "ready",
			protocol: APP_PROTOCOL_VERSION,
			principal: connection.principal.id,
			name: connection.principal.name,
			uploads: {
				perMessage: MAX_MESSAGE_FILES,
				maxBytes: UPLOAD_MAX_BYTES,
				types: [...UPLOAD_TYPES],
			},
		});
		for (const frame of desk.openFrames()) sockets.send(connection, frame);
	}

	/** The person behind a socket as an answerer at their tier now; undefined when they are no owner any more. */
	async #owner(connection: AppSocket): Promise<Answerer | undefined> {
		const tier = await this.#options.identity.tierOf(connection.principal.id);
		if (tier !== "owner") return undefined;
		return {
			principalId: connection.principal.id,
			tier,
			speakerId: identityOf(connection.actor, connection.principal.id),
			name: connection.principal.name,
			...(connection.actor ? { actor: connection.actor } : {}),
		};
	}

	#refuse(
		connection: AppSocket,
		code: RefusalCode,
		id?: string,
		prompt?: string,
	): void {
		this.#options.sockets.send(connection, {
			type: "refused",
			code,
			...(id === undefined ? {} : { id }),
			...(prompt === undefined ? {} : { prompt }),
		});
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
		// What a socket shows or watches applies the moment its frame arrives: the owner lookup
		// below awaits, and frames that waited on it could land out of order.
		switch (frame.type) {
			case "hello":
				connection.visible = frame.visible;
				connection.focus = frame.focus;
				break;
			case "visibility":
				connection.visible = frame.visible;
				break;
			case "focus":
				connection.focus = frame.room;
				break;
			default:
				break;
		}
		// Every frame comes from an owner, at their tier now; a socket whose person is no owner
		// any more is closed rather than left to receive what the owners are shown.
		const who = await this.#owner(connection);
		if (!who) {
			this.#refuse(
				connection,
				"forbidden",
				frame.type === "send" ? frame.id : undefined,
			);
			socket.close(APP_CLOSE_FORBIDDEN, "forbidden");
			return;
		}
		if (
			frame.type === "hello" ||
			frame.type === "visibility" ||
			frame.type === "focus"
		)
			return;
		await this.#write(connection, who, frame);
	}

	async #write(
		connection: AppSocket,
		who: Answerer,
		frame: Exclude<ClientFrame, { type: "hello" | "visibility" | "focus" }>,
	): Promise<void> {
		const { desk, rooms, conversations } = this.#options;
		let refused: RefusalCode | undefined;
		switch (frame.type) {
			case "send":
				await this.#send(connection, who, frame);
				return;
			case "stop": {
				const room = await rooms.resolve(frame.room);
				if (!room || room.readOnly) refused = "unknown_room";
				else conversations.stop(room.key);
				break;
			}
			case "approval":
				refused = this.#needsActor(who, frame.prompt)
					? "forbidden"
					: desk.approve(who, frame.prompt, frame.approved);
				break;
			case "answer":
				refused = this.#needsActor(who, frame.prompt)
					? "forbidden"
					: desk.answer(who, frame.prompt, frame.answer);
				break;
			case "answers":
				refused = this.#needsActor(who, frame.prompt)
					? "forbidden"
					: desk.answers(who, frame.prompt, frame.answers, frame.note);
				break;
			case "cancel":
				refused = desk.cancel(who, frame.prompt);
				break;
		}
		if (refused)
			this.#refuse(
				connection,
				refused,
				undefined,
				"prompt" in frame ? frame.prompt : undefined,
			);
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
				sockets.send(connection, {
					type: "accepted",
					id: frame.id,
					room: room.key,
					message,
				}),
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
