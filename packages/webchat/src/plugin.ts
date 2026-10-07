import {
	CONVERSATIONS,
	definePlugin,
	type HttpRoute,
	type PluginContext,
	type RoundtablePlugin,
	RUNTIME,
	type WebSocketAccept,
	type WebSocketRoute,
} from "pi-roundtable";
import { type WebAccess, type WebAccessMap, webAccess } from "./access.ts";
import {
	type Admitted,
	checkPersonas,
	Refusal,
	WebChat,
	type WebChatLimits,
	type WebPersona,
} from "./chat.ts";
import type { Connection } from "./connections.ts";
import { TokenRefused, type TokenVerifier } from "./oidc.ts";
import { TICKET_PROTOCOL_PREFIX, WEBCHAT_PROTOCOL } from "./protocol.ts";
import { restHandler } from "./rest.ts";
import { TicketBook } from "./tickets.ts";

/** Limits of the WebSocket route, besides the chat's own. */
export interface WebChatRouteLimits {
	/** Sockets the route holds open at once, for everyone together; default 256. */
	maxConnections: number;
	/** The largest client frame in bytes; default 64 KiB. */
	maxMessageBytes: number;
	/** Frames one socket may send per window; default 60 a minute. */
	rate: { messages: number; perMs: number };
	/** Bytes one socket may have waiting for a slow client before it is cut; default 4 MiB, room for a reply with files. */
	maxBufferedBytes: number;
	/** How long a WebSocket ticket may wait before it is spent; default 30 seconds. */
	ticketTtlMs: number;
}

export interface WebChatOptions {
	/** Checks each bearer token, such as `oidcJwtVerifier({ ... })`. */
	verifier: TokenVerifier;
	/** Who may chat and at which tier: an access map, or `webAccess(map)`. */
	access: WebAccessMap | WebAccess;
	/** The conversation kinds a person may open. */
	personas: readonly WebPersona[];
	/**
	 * The browser origins allowed to open the WebSocket and call the API, each exactly
	 * `scheme://host[:port]` as the browser sends it, such as `https://chat.example.com` or
	 * `chrome-extension://<id>`. Required: `"any"` admits every origin, for clients that are not
	 * browsers, and must never be used where a browser holds the token.
	 */
	origins: readonly string[] | "any";
	/** The configured listener the route attaches to; default `public`. */
	listener?: string;
	/** Where the API and the socket live; default `/chat` (`/chat/socket`, `/chat/conversations`, …). */
	path?: string;
	/** The key prefix of the conversations; default `web`. Two web chats on one host need two. */
	surface?: string;
	limits?: Partial<WebChatLimits & WebChatRouteLimits>;
}

const DEFAULT_LIMITS: WebChatLimits & WebChatRouteLimits = {
	connectionsPerPrincipal: 5,
	unusedConversationsPerPrincipal: 20,
	newConversationsPerHour: 60,
	turnsPerPrincipal: 2,
	messageChars: 32_000,
	promptTimeoutMs: 30 * 60_000,
	reauthLeadMs: 60_000,
	maxConnections: 256,
	maxMessageBytes: 64 * 1024,
	rate: { messages: 60, perMs: 60_000 },
	maxBufferedBytes: 4 * 1024 * 1024,
	ticketTtlMs: 30_000,
};

const isAccess = (access: WebAccessMap | WebAccess): access is WebAccess =>
	typeof (access as WebAccess).tierOf === "function";

function checkOptions(options: WebChatOptions): {
	path: string;
	surface: string;
} {
	const path = options.path ?? "/chat";
	if (!/^\/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$/.test(path))
		throw new Error(
			`webChat: path ${JSON.stringify(path)} must start with / and not end with one, such as /chat`,
		);
	const surface = options.surface ?? "web";
	if (!/^[a-z][a-z0-9-]*$/.test(surface))
		throw new Error(
			`webChat: surface ${JSON.stringify(surface)} must be a lowercase word, such as web`,
		);
	if (options.origins !== "any" && options.origins.length === 0)
		throw new Error(
			'webChat: origins is empty; list the origins your web pages are served from, or write "any" for clients that are not browsers',
		);
	return { path, surface };
}

/** The subprotocols a WebSocket upgrade offers. */
function offered(request: Request): string[] {
	return (request.headers.get("sec-websocket-protocol") ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

/**
 * A chat on the host's HTTP listener for people an OpenID Connect provider signs in: a REST API
 * and a WebSocket under `path`, a `web:` chat surface, and the claim that runs each message as a
 * turn of its conversation's persona through `context.turns`. Every conversation is private to the
 * person who opened it. A browser opens the socket with a one-time ticket from `POST <path>/tickets`
 * in the `ticket.<ticket>` subprotocol beside `roundtable.webchat.v1`; another client may send
 * `Authorization: Bearer <token>` on the upgrade instead. The token is never read from a URL.
 * Configuration mistakes throw here, before the host starts.
 */
export function webChat(options: WebChatOptions): RoundtablePlugin {
	const { path, surface } = checkOptions(options);
	const limits = { ...DEFAULT_LIMITS, ...options.limits };
	const access = isAccess(options.access)
		? options.access
		: webAccess(options.access);
	// The personas are checked now, so a broken list stops the configuration rather than the boot.
	checkPersonas(options.personas);
	return definePlugin({
		name: surface === "web" ? "webchat" : `webchat-${surface}`,
		requires: [CONVERSATIONS, RUNTIME],
		setup: (context: PluginContext) => {
			const chat = new WebChat({
				surface,
				verifier: options.verifier,
				access,
				personas: options.personas,
				limits,
				logger: context.logger,
				registry: () => context.services.get(CONVERSATIONS),
				conversations: () => context.conversations,
				turns: () => context.turns,
				runtime: () => context.services.get(RUNTIME),
			});
			const tickets = new TicketBook({ ttlMs: limits.ticketTtlMs });
			const rest = restHandler({
				chat,
				tickets,
				path,
				origins: options.origins,
				logger: context.logger,
			});
			const refuse = (status: number, text: string) =>
				new Response(text, { status });
			const accept = async (
				request: Request,
			): Promise<WebSocketAccept<Connection>> => {
				if (URL.parse(request.url)?.pathname !== `${path}/socket`)
					return refuse(404, "Not Found");
				const protocols = offered(request);
				if (!protocols.includes(WEBCHAT_PROTOCOL))
					return refuse(400, `Offer the ${WEBCHAT_PROTOCOL} subprotocol`);
				const ticket = protocols
					.find((p) => p.startsWith(TICKET_PROTOCOL_PREFIX))
					?.slice(TICKET_PROTOCOL_PREFIX.length);
				const token = /^Bearer\s+(\S+)$/i.exec(
					request.headers.get("authorization") ?? "",
				)?.[1];
				let admitted: Admitted;
				try {
					if (token) admitted = await chat.admit(token);
					else if (ticket) {
						const identity = tickets.redeem(ticket);
						if (!identity) return refuse(401, "Unauthorized");
						admitted = chat.admitIdentity(identity);
					} else return refuse(401, "Unauthorized");
				} catch (error) {
					if (error instanceof TokenRefused) {
						context.logger.info(
							{ reason: error.reason },
							"a web chat upgrade was refused",
						);
						return refuse(401, "Unauthorized");
					}
					if (error instanceof Refusal) return refuse(403, "Forbidden");
					throw error;
				}
				const connection: Connection = { ...admitted, timers: [] };
				if (!chat.connections.reserve(connection))
					return refuse(429, "Too Many Connections");
				return {
					data: connection,
					headers: { "Sec-WebSocket-Protocol": WEBCHAT_PROTOCOL },
				};
			};
			const websocket: WebSocketRoute<Connection> = {
				origins: options.origins,
				maxConnections: limits.maxConnections,
				maxMessageBytes: limits.maxMessageBytes,
				maxBufferedBytes: limits.maxBufferedBytes,
				rate: limits.rate,
				accept,
				open: (socket) => chat.opened(socket),
				message: (socket, message) => chat.message(socket, message),
				close: (socket) => chat.closed(socket),
			};
			const route: HttpRoute = {
				name: `${surface}-chat`,
				listener: options.listener ?? "public",
				path: { prefix: `${path}/` },
				handle: rest,
				websocket,
			};
			return {
				surfaces: [chat.surface],
				channels: [chat.claim()],
				personas: chat.contributedPersonas,
				http: [route],
			};
		},
	});
}
