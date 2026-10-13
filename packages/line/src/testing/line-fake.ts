import { createHmac } from "node:crypto";

export const CHANNEL_ID = "2000000001";
export const SECRET = "channel-secret-for-tests-only";
export const BOT = "Ubot-for-tests";

export const sign = (body: string | Uint8Array, secret = SECRET): string =>
	createHmac("sha256", secret).update(body).digest("base64");

/** A signed POST of `body` to the webhook. */
export function webhookRequest(
	body: string | Uint8Array,
	init: { signature?: string | null; headers?: Record<string, string> } = {},
): Request {
	const headers: Record<string, string> = { ...init.headers };
	const signature = init.signature === undefined ? sign(body) : init.signature;
	if (signature !== null) headers["x-line-signature"] = signature;
	return new Request("https://hook.example.test/line/webhook", {
		method: "POST",
		headers,
		body,
	});
}

export const GROUP = "line:group:Cgroup0001";
export const OTHER_GROUP = "line:group:Cgroup0002";

export function messageEvent(
	options: {
		id?: string;
		group?: string;
		text?: string;
		timestamp?: number;
		messageId?: string;
		type?: string;
	} = {},
): Record<string, unknown> {
	const id = options.id ?? "ev-1";
	return {
		type: options.type ?? "message",
		mode: "active",
		timestamp: options.timestamp ?? 1_700_000_000_000,
		webhookEventId: id,
		deliveryContext: { isRedelivery: false },
		source: {
			type: "group",
			groupId: options.group ?? "Cgroup0001",
			userId: "Uuser0001",
		},
		replyToken: `reply-${id}`,
		message: {
			id: options.messageId ?? `m-${id}`,
			type: "text",
			text: options.text ?? "hello there",
		},
	};
}

/** One message-event of a kind other than text, for the typed mapping. */
export function mediaEvent(
	message: Record<string, unknown>,
	options: { id?: string; messageId?: string; timestamp?: number } = {},
): Record<string, unknown> {
	const event = messageEvent(options);
	return {
		...event,
		message: {
			id: options.messageId ?? `m-${options.id ?? "ev-1"}`,
			...message,
		},
	};
}

export const body = (...events: Record<string, unknown>[]): string =>
	JSON.stringify({ destination: BOT, events });

interface Call {
	url: string;
	method: string;
	authorization: string | undefined;
	body: string;
	retryKey: string | undefined;
}

/** What the fake answers a push or a reply with, instead of success. */
export interface Scripted {
	status: number;
	/** LINE's JSON error body. */
	body?: unknown;
	headers?: Record<string, string>;
}

/** A push or reply the fake received. */
export interface Received {
	to: string;
	messages: Record<string, unknown>[];
	retryKey: string | undefined;
	status: number;
}

/** What the fake serves at `/v2/bot/message/<id>/content`. */
export interface FakeContent {
	bytes: Uint8Array;
	contentType?: string;
	/** Serve the body as a stream with no `content-length`, in chunks of this size. */
	streamChunk?: number;
}

export interface FakeLine {
	fetch: typeof fetch;
	calls: Call[];
	/** Every access token issued, in order. */
	issued: string[];
	/** Makes LINE refuse this token with 401 from now on. */
	revoke(token: string): void;
	/** Answers the token endpoint with `status` (and a body that echoes the request) until cleared. */
	failTokens(status: number | undefined): void;
	/** Makes every call throw a network error whose message quotes its request headers. */
	breakNetwork(on: boolean): void;
	/** Changes the lifetime of the tokens issued from now on. */
	expiresIn: number;
	groupNames: Record<string, string>;
	/** Message content by message id; an id that is not here (or is `null`) is gone: 404. */
	contents: Record<string, FakeContent | null>;
	/** The statuses `/content/transcoding` answers for a message in turn; the last one repeats. */
	transcoding: Record<string, string[]>;
	/** Message ids whose content download never answers until its signal aborts. */
	hang: Set<string>;
	/** Message ids whose transcoding status never answers until its signal aborts. */
	hangTranscoding: Set<string>;
	/** Every push, in order, with the status it was answered with. */
	pushes: Received[];
	/** Statuses (or scripted answers) for the next pushes in turn; once empty, pushes succeed. */
	pushScript: (number | Scripted)[];
	/** Every reply, in order. */
	replies: {
		replyToken: string;
		messages: Record<string, unknown>[];
		status: number;
	}[];
	/** Statuses for the next replies in turn; once empty, a reply succeeds (a token only once). */
	replyScript: (number | Scripted)[];
	/** Retry keys of pushes LINE accepted: the same key again is a 409. */
	acceptedKeys: Set<string>;
	/** The plan's monthly limit; `null` is a plan without one. */
	quota: number | null;
	/** Messages used this month; an accepted push adds its recipients. */
	usage: number;
	/** Member counts by group id, room id as well. */
	members: Record<string, number>;
	/** Makes the quota endpoints answer with this status until cleared. */
	failQuota(status: number | undefined): void;
	/** Delays every push's answer by this many milliseconds. */
	pushDelayMs: number;
}

/** A LINE that issues tokens, knows the bot and the group names, and records every call. */
export function fakeLine(): FakeLine {
	const revoked = new Set<string>();
	let tokenStatus: number | undefined;
	let network = false;
	let quotaStatus: number | undefined;
	const answer = (script: number | Scripted | undefined, requestId: string) => {
		const scripted = typeof script === "number" ? { status: script } : script;
		const status = scripted?.status ?? 200;
		return {
			status,
			response: new Response(
				scripted?.body === undefined ? "{}" : JSON.stringify(scripted.body),
				{
					status,
					headers: { "x-line-request-id": requestId, ...scripted?.headers },
				},
			),
		};
	};
	const fake: FakeLine = {
		calls: [],
		issued: [],
		expiresIn: 900,
		groupNames: { Cgroup0001: "Group One" },
		contents: {},
		transcoding: {},
		hang: new Set(),
		hangTranscoding: new Set(),
		pushes: [],
		pushScript: [],
		replies: [],
		replyScript: [],
		acceptedKeys: new Set(),
		quota: 1000,
		usage: 0,
		members: { Cgroup0001: 3, Cgroup0002: 40 },
		pushDelayMs: 0,
		failQuota: (status) => {
			quotaStatus = status;
		},
		revoke: (token) => void revoked.add(token),
		failTokens: (status) => {
			tokenStatus = status;
		},
		breakNetwork: (on) => {
			network = on;
		},
		fetch: (async (input: Request | string | URL, init?: RequestInit) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			const sent = init?.body ? String(init.body) : "";
			const call: Call = {
				url,
				method: init?.method ?? "GET",
				authorization: headers.get("authorization") ?? undefined,
				body: sent,
				retryKey: headers.get("x-line-retry-key") ?? undefined,
			};
			fake.calls.push(call);
			if (network)
				throw new TypeError(
					`connect failed for ${url} with ${call.authorization ?? ""} ${sent}`,
				);
			const path = new URL(url).pathname;
			if (path === "/oauth2/v3/token") {
				if (tokenStatus !== undefined)
					return new Response(`rejected: ${sent}`, { status: tokenStatus });
				const form = new URLSearchParams(sent);
				if (
					form.get("grant_type") !== "client_credentials" ||
					form.get("client_id") !== CHANNEL_ID ||
					form.get("client_secret") !== SECRET
				)
					return new Response("{}", { status: 400 });
				const token = `access-token-${fake.issued.length + 1}`;
				fake.issued.push(token);
				return Response.json({
					access_token: token,
					token_type: "Bearer",
					expires_in: fake.expiresIn,
				});
			}
			const token = call.authorization?.replace(/^Bearer /, "");
			if (!token || !fake.issued.includes(token) || revoked.has(token))
				return new Response("unauthorized", { status: 401 });
			if (path === "/v2/bot/info") return Response.json({ userId: BOT });
			if (path === "/v2/bot/message/push" && call.method === "POST") {
				const request = JSON.parse(sent) as {
					to: string;
					messages: Record<string, unknown>[];
				};
				if (fake.pushDelayMs > 0)
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(resolve, fake.pushDelayMs);
						init?.signal?.addEventListener("abort", () => {
							clearTimeout(timer);
							reject(init.signal?.reason);
						});
					});
				const key = call.retryKey;
				const requestId = `req-${fake.pushes.length + 1}`;
				let result = answer(fake.pushScript.shift(), requestId);
				if (result.status < 300 && key && fake.acceptedKeys.has(key))
					result = answer(409, requestId);
				if (result.status < 300) {
					if (key) fake.acceptedKeys.add(key);
					fake.usage += fake.members[request.to] ?? 1;
				}
				fake.pushes.push({
					to: request.to,
					messages: request.messages,
					retryKey: key,
					status: result.status,
				});
				return result.response;
			}
			if (path === "/v2/bot/message/reply" && call.method === "POST") {
				const request = JSON.parse(sent) as {
					replyToken: string;
					messages: Record<string, unknown>[];
				};
				const used = fake.replies.some(
					(r) => r.replyToken === request.replyToken && r.status < 300,
				);
				const result = answer(
					fake.replyScript.length > 0
						? fake.replyScript.shift()
						: used
							? 400
							: 200,
					`rep-${fake.replies.length + 1}`,
				);
				fake.replies.push({ ...request, status: result.status });
				return result.response;
			}
			if (path === "/v2/bot/message/quota") {
				if (quotaStatus !== undefined)
					return new Response("{}", { status: quotaStatus });
				return Response.json(
					fake.quota === null
						? { type: "none" }
						: { type: "limited", value: fake.quota },
				);
			}
			if (path === "/v2/bot/message/quota/consumption") {
				if (quotaStatus !== undefined)
					return new Response("{}", { status: quotaStatus });
				return Response.json({ totalUsage: fake.usage });
			}
			const counted =
				/^\/v2\/bot\/(?:group|room)\/([^/]+)\/members\/count$/.exec(path)?.[1];
			if (counted)
				return fake.members[counted] === undefined
					? new Response("{}", { status: 404 })
					: Response.json({ count: fake.members[counted] });
			const media =
				/^\/v2\/bot\/message\/([^/]+)\/content(\/transcoding)?$/.exec(path);
			if (media) {
				const id = media[1] as string;
				if (new URL(url).host !== "api-data.line.me")
					return new Response("wrong host", { status: 404 });
				if (media[2]) {
					if (fake.hangTranscoding.has(id))
						return new Promise<Response>((_, reject) => {
							init?.signal?.addEventListener("abort", () =>
								reject(init.signal?.reason),
							);
						});
					const steps = fake.transcoding[id];
					if (!steps?.length) return new Response("{}", { status: 404 });
					const status = steps.length > 1 ? steps.shift() : steps[0];
					return Response.json({ status });
				}
				if (fake.hang.has(id))
					return new Promise<Response>((_, reject) => {
						init?.signal?.addEventListener("abort", () =>
							reject(init.signal?.reason),
						);
					});
				const content = fake.contents[id];
				if (!content) return new Response("gone", { status: 404 });
				const headers = {
					"content-type": content.contentType ?? "application/octet-stream",
				};
				if (content.streamChunk === undefined)
					return new Response(content.bytes, { headers });
				const chunk = content.streamChunk;
				let offset = 0;
				return new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							if (offset >= content.bytes.length) return controller.close();
							controller.enqueue(content.bytes.slice(offset, offset + chunk));
							offset += chunk;
						},
					}),
					{ headers },
				);
			}
			const group = /^\/v2\/bot\/group\/([^/]+)\/summary$/.exec(path)?.[1];
			if (group && fake.groupNames[group])
				return Response.json({
					groupId: group,
					groupName: fake.groupNames[group],
				});
			return new Response("{}", { status: 404 });
		}) as typeof fetch,
	};
	return fake;
}
