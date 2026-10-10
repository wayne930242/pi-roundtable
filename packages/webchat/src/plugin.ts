import {
	CONVERSATIONS,
	definePlugin,
	type HttpRoute,
	IDENTITY,
	type PluginContext,
	type RoundtablePlugin,
	RUNTIME,
	type WebSocketAccept,
	type WebSocketRoute,
} from "pi-roundtable";
import {
	type Admitted,
	checkPersonas,
	Refusal,
	WebChat,
	type WebChatLimits,
	type WebPersona,
} from "./chat.ts";
import type { Connection } from "./connections.ts";
import { webDirectChannel } from "./direct-channel.ts";
import { PgNotices } from "./notices.ts";
import { TokenRefused, type TokenVerifier } from "./oidc.ts";
import { TICKET_PROTOCOL_PREFIX, WEBCHAT_PROTOCOL } from "./protocol.ts";
import { restHandler } from "./rest.ts";
import { TicketBook } from "./tickets.ts";
import { DEFAULT_ATTACHMENT_TYPES } from "./uploads.ts";

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
	attachmentBytes: 10 * 1024 * 1024,
	attachmentsPerMessage: 8,
	uploadsPerHour: 60,
	unsentUploadBytesPerPrincipal: 64 * 1024 * 1024,
	usedAttachmentBytesPerPrincipal: 1024 * 1024 * 1024,
	attachmentTypes: DEFAULT_ATTACHMENT_TYPES,
	unsentUploadTtlMs: 24 * 60 * 60_000,
	maxConnections: 256,
	maxMessageBytes: 64 * 1024,
	rate: { messages: 60, perMs: 60_000 },
	maxBufferedBytes: 4 * 1024 * 1024,
	ticketTtlMs: 30_000,
};

function checkOptions(options: WebChatOptions): {
	path: string;
	surface: string;
} {
	if ("access" in options)
		throw new Error(
			'webChat: access was removed; use top-level access on RoundtableConfig: members/admins roles become "<surface>:role:<role>", users become identities, and owners become access.owners[].identities. Replace everyone: true with everyone: ["<surface>"] (substitute this chat\'s surface, default "web"); core everyone: true opens every surface.',
		);
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

/** The core keeps no file over this; a web chat's own limit may be lower, never higher. */
const CORE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** The longest wait between two sweeps of uploads no message used. */
const SWEEP_EVERY_MS = 10 * 60_000;

/** Refuses an attachment limit that is not a positive whole number, or a size the core cannot keep. */
function checkAttachmentLimits(limits: WebChatLimits): void {
	for (const key of [
		"attachmentBytes",
		"attachmentsPerMessage",
		"uploadsPerHour",
		"unsentUploadBytesPerPrincipal",
		"usedAttachmentBytesPerPrincipal",
		"unsentUploadTtlMs",
	] as const)
		if (!Number.isInteger(limits[key]) || limits[key] < 1)
			throw new Error(
				`webChat: limits.${key} must be a positive whole number; got ${String(limits[key])}`,
			);
	if (limits.attachmentBytes > CORE_ATTACHMENT_BYTES)
		throw new Error(
			`webChat: limits.attachmentBytes may be at most ${CORE_ATTACHMENT_BYTES} (25 MiB), the most the core keeps; got ${limits.attachmentBytes}`,
		);
	if (
		!Array.isArray(limits.attachmentTypes) ||
		limits.attachmentTypes.some(
			(type) =>
				typeof type !== "string" ||
				!/^[a-z0-9.+-]+\/(\*|[a-z0-9.+-]+)$/.test(type),
		)
	)
		throw new Error(
			'webChat: limits.attachmentTypes must list content types in lower case, such as "image/png" or "image/*"',
		);
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
	// The personas are checked now, so a broken list stops the configuration rather than the boot.
	checkPersonas(options.personas);
	checkAttachmentLimits(limits);
	return definePlugin({
		name: surface === "web" ? "webchat" : `webchat-${surface}`,
		requires: [IDENTITY, CONVERSATIONS, RUNTIME],
		migrations: [PgNotices.migration],
		setup: (context: PluginContext) => {
			if (!context.attachments)
				throw new Error(
					"webChat: this version keeps uploaded files with context.attachments, which pi-roundtable 0.9.2 added. Update pi-roundtable to 0.9.2 or later.",
				);
			const chat = new WebChat({
				surface,
				verifier: options.verifier,
				identity: () => context.services.get(IDENTITY),
				personas: options.personas,
				limits,
				logger: context.logger,
				registry: () => context.services.get(CONVERSATIONS),
				conversations: () => context.conversations,
				attachments: () => context.attachments,
				turns: () => context.turns,
				runtime: () => context.services.get(RUNTIME),
			});
			// A person needs no more tickets waiting than the sockets they may open.
			const tickets = new TicketBook({
				ttlMs: limits.ticketTtlMs,
				perPrincipal: limits.connectionsPerPrincipal,
			});
			const notices = new PgNotices(context.database(), { ...limits, surface });
			const rest = restHandler({
				chat,
				notices,
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
						const held = tickets.redeem(ticket);
						if (!held) return refuse(401, "Unauthorized");
						admitted = await chat.admitIdentity(held.identity);
						if (admitted.speaker.principalId !== held.principalId)
							return refuse(403, "Forbidden");
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
			// Uploads no message used are deleted once they are older than the limit's time.
			let sweeper: ReturnType<typeof setInterval> | undefined;
			const sweep = async () => {
				try {
					const dropped = await chat.uploads.sweep();
					if (dropped > 0)
						context.logger.info({ dropped }, "unused web chat uploads deleted");
				} catch (error) {
					context.logger.warn(
						{ err: error },
						"unused web chat uploads not deleted",
					);
				}
			};
			return {
				services: [
					{
						name: `${surface}-uploads`,
						start: async () => {
							// Not caught: a host without a `dataDir` stops here, naming it, instead of failing at the first upload.
							await chat.uploads.sweep();
							sweeper = setInterval(
								sweep,
								Math.min(
									SWEEP_EVERY_MS,
									Math.max(limits.unsentUploadTtlMs, 100),
								),
							);
						},
						stop: () => {
							clearInterval(sweeper);
							sweeper = undefined;
						},
					},
				],
				surfaces: [chat.surface],
				channels: [chat.claim()],
				directChannels: [
					webDirectChannel({
						chat,
						notices,
						identity: () => context.services.get(IDENTITY),
						registry: () => context.services.get(CONVERSATIONS),
					}),
				],
				personas: chat.contributedPersonas,
				http: [route],
			};
		},
	});
}
