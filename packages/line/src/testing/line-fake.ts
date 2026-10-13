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
}

/** A LINE that issues tokens, knows the bot and the group names, and records every call. */
export function fakeLine(): FakeLine {
	const revoked = new Set<string>();
	let tokenStatus: number | undefined;
	let network = false;
	const fake: FakeLine = {
		calls: [],
		issued: [],
		expiresIn: 900,
		groupNames: { Cgroup0001: "Group One" },
		contents: {},
		transcoding: {},
		hang: new Set(),
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
			const media =
				/^\/v2\/bot\/message\/([^/]+)\/content(\/transcoding)?$/.exec(path);
			if (media) {
				const id = media[1] as string;
				if (new URL(url).host !== "api-data.line.me")
					return new Response("wrong host", { status: 404 });
				if (media[2]) {
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
