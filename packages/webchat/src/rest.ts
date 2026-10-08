import type { ConversationRecord, Logger } from "pi-roundtable";
import { type Admitted, Refusal, type WebChat } from "./chat.ts";
import type { PgNotices } from "./notices.ts";
import { TokenRefused } from "./oidc.ts";
import type { TicketBook } from "./tickets.ts";

export interface RestOptions {
	chat: WebChat;
	tickets: TicketBook;
	notices: PgNotices;
	/** The route's path, such as `/chat`, without a trailing slash. */
	path: string;
	/** The browser origins allowed to call the API; "any" answers every origin. */
	origins: readonly string[] | "any";
	logger: Logger;
}

/** The most transcript entries one request returns. */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
const MAX_BODY_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type HeaderMap = Record<string, string>;

const json = (body: unknown, status = 200, headers: HeaderMap = {}) =>
	Response.json(body, { status, headers });

function bearer(request: Request): string | undefined {
	const header = request.headers.get("authorization");
	const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
	return match?.[1];
}

function summary(record: ConversationRecord, surface: string) {
	return {
		conversation: record.key.slice(surface.length + 1),
		persona: record.kind,
		...(record.title === undefined ? {} : { title: record.title }),
		createdAt: record.createdAt.toISOString(),
		lastActiveAt: record.lastActiveAt.toISOString(),
	};
}

async function body(request: Request): Promise<Record<string, unknown>> {
	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) throw new Refusal("bad_frame");
	let value: unknown;
	try {
		value = text === "" ? {} : JSON.parse(text);
	} catch {
		throw new Refusal("bad_frame");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Refusal("bad_frame");
	return value as Record<string, unknown>;
}

const STATUS: Record<string, number> = {
	bad_frame: 400,
	forbidden: 403,
	unknown_conversation: 404,
	unknown_persona: 404,
	too_many_conversations: 429,
};

/**
 * The web chat's REST API, under its path, every call with `Authorization: Bearer <token>`:
 * `POST tickets` (a one-time ticket for the WebSocket), `GET conversations` (the caller's own),
 * `POST conversations` (`{ persona, title? }` opens one), and `GET conversations/<id>/messages`
 * (`?limit=`, its last messages). A browser on another origin gets CORS headers when its origin
 * is allowed and 403 otherwise.
 */
export function restHandler(options: RestOptions) {
	const { chat, tickets, notices, path, origins, logger } = options;
	const surface = chat.surface.surface;
	const cors = (origin: string | null): HeaderMap | undefined => {
		if (origin === null) return {};
		if (origins !== "any" && !origins.includes(origin)) return undefined;
		return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
	};
	async function route(
		request: Request,
		url: URL,
		who: Admitted,
		headers: HeaderMap,
	): Promise<Response> {
		const rest = url.pathname.slice(path.length + 1);
		const { speaker, identity } = who;
		if (rest === "tickets" && request.method === "POST") {
			const { ticket, expiresAt } = tickets.issue(
				identity,
				speaker.principalId,
			);
			return json({ ticket, expiresAt: expiresAt.toISOString() }, 201, headers);
		}
		if (rest === "notices" && request.method === "GET") {
			const before = url.searchParams.get("before") ?? undefined;
			if (before !== undefined && !UUID.test(before))
				throw new Refusal("bad_frame");
			const asked = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
			const limit = Number.isInteger(asked)
				? Math.min(Math.max(asked, 1), MAX_LIMIT)
				: DEFAULT_LIMIT;
			return json(
				{ notices: await notices.list(speaker.principalId, limit, before) },
				200,
				headers,
			);
		}
		const readNotice = /^notices\/([^/]+)\/read$/.exec(rest);
		if (readNotice?.[1] && request.method === "POST") {
			if (!UUID.test(readNotice[1])) throw new Refusal("bad_frame");
			const notice = await notices.read(speaker.principalId, readNotice[1]);
			return notice
				? json({ notice }, 200, headers)
				: json({ error: "not_found" }, 404, headers);
		}
		if (rest === "conversations" && request.method === "GET") {
			const records = await chat.list(speaker);
			return json(
				{ conversations: records.map((r) => summary(r, surface)) },
				200,
				headers,
			);
		}
		if (rest === "conversations" && request.method === "POST") {
			const { persona, title } = await body(request);
			if (typeof persona !== "string") throw new Refusal("bad_frame");
			if (title !== undefined && typeof title !== "string")
				throw new Refusal("bad_frame");
			const conversation = chat.open(speaker, persona, title);
			return json({ conversation, persona }, 201, headers);
		}
		const messages = /^conversations\/([A-Za-z0-9-]{1,128})\/messages$/.exec(
			rest,
		);
		if (messages?.[1] && request.method === "GET") {
			const asked = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
			const limit = Number.isInteger(asked)
				? Math.min(Math.max(asked, 1), MAX_LIMIT)
				: DEFAULT_LIMIT;
			const entries = await chat.transcript(speaker, messages[1], limit);
			return json({ messages: entries }, 200, headers);
		}
		return json({ error: "not_found" }, 404, headers);
	}
	return async (request: Request): Promise<Response> => {
		const headers = cors(request.headers.get("origin"));
		if (!headers) return json({ error: "forbidden" }, 403);
		if (request.method === "OPTIONS")
			return new Response(null, {
				status: 204,
				headers: {
					...headers,
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": "authorization, content-type",
					"Access-Control-Max-Age": "600",
				},
			});
		// A request the listener received always has an absolute URL.
		const url = URL.parse(request.url);
		if (!url) return json({ error: "not_found" }, 404, headers);
		const token = bearer(request);
		const challenge = { ...headers, "WWW-Authenticate": "Bearer" };
		if (!token) return json({ error: "unauthorized" }, 401, challenge);
		let who: Admitted;
		try {
			who = await chat.admit(token);
		} catch (error) {
			if (error instanceof TokenRefused) {
				logger.info({ reason: error.reason }, "a web chat token was refused");
				return json({ error: "unauthorized" }, 401, challenge);
			}
			if (error instanceof Refusal)
				return json({ error: "forbidden" }, 403, headers);
			throw error;
		}
		try {
			return await route(request, url, who, headers);
		} catch (error) {
			if (!(error instanceof Refusal)) throw error;
			return json({ error: error.code }, STATUS[error.code] ?? 400, headers);
		}
	};
}
