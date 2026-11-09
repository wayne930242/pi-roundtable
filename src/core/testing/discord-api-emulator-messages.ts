import {
	type Ctx,
	channelOf,
	type Route,
} from "./discord-api-emulator-guild.ts";
import {
	BOT_ID,
	COMPONENTS_V2,
	type EmuChannel,
	type EmuMessage,
	type EmuState,
	type EmuWebhook,
	formError,
	HttpError,
	mentionsOf,
	messageJson,
	newId,
	str,
	unknownMessage,
} from "./discord-api-emulator-state.ts";

/** The most pins a channel keeps. */
const PIN_LIMIT = 250;

/** The most webhooks a channel holds. */
const WEBHOOKS_PER_CHANNEL = 15;

const FORBIDDEN_WORDS = /clyde|discord/i;

// Messages, webhooks and pins.

export function add(
	state: EmuState,
	channel: EmuChannel,
	fields: Partial<EmuMessage> & { authorId: string },
	body: Record<string, unknown>,
): EmuMessage {
	const id = newId(state);
	const files = Array.isArray(body.__files) ? (body.__files as File[]) : [];
	const mentions = mentionsOf(body);
	const message: EmuMessage = {
		id,
		channelId: channel.id,
		content: str(body.content) ?? "",
		flags: typeof body.flags === "number" ? body.flags : 0,
		...(body.components ? { components: body.components } : {}),
		...(Array.isArray(body.embeds) && body.embeds.length > 0
			? { embeds: body.embeds }
			: {}),
		attachments: files.map((file, index) => ({
			id: newId(state),
			filename: file.name,
			size: file.size,
			content_type: file.type,
			url: `https://cdn.emulated.test/${id}/${index}/${encodeURIComponent(file.name)}`,
		})),
		...(mentions ? { allowedMentions: mentions } : {}),
		type: 0,
		...fields,
	};
	channel.messages.push(message);
	return message;
}

const UNION_ERROR =
	"Value of field type must be one of (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17)";

function hasEmbeds(body: Record<string, unknown>): boolean {
	return Array.isArray(body.embeds) && body.embeds.length > 0;
}

/** Discord refuses `content` and `embeds` on a Components V2 message. */
function legacyFieldsOnV2(): HttpError {
	return formError(
		"content",
		"MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2",
		"Messages using components v2 cannot use content, embeds, poll or sticker_ids",
	);
}

/**
 * What a message body may hold. A Components V2 one needs its flag and carries no `content` or
 * embeds; one without the flag holds action rows only, else Discord answers a union error.
 */
export function checkCard(body: Record<string, unknown>): void {
	if ((Number(body.flags ?? 0) & COMPONENTS_V2) !== 0) {
		if (str(body.content) !== undefined || hasEmbeds(body))
			throw legacyFieldsOnV2();
		return;
	}
	if (body.components === undefined) return;
	const rows = Array.isArray(body.components) ? body.components : [];
	if (rows.some((row) => (row as { type?: unknown } | null)?.type !== 1))
		throw formError("components[0]", "UNION_TYPE_CHOICES", UNION_ERROR);
	if (rows.length > 5)
		throw formError(
			"components",
			"BASE_TYPE_MAX_LENGTH",
			"Must be 5 or fewer in length.",
		);
}

/** An edit of a message's content, embeds and components, in the rules of its kind. */
function applyEdit(
	message: EmuMessage,
	body: Record<string, unknown>,
	components: boolean,
): void {
	const v2 = (message.flags & COMPONENTS_V2) !== 0;
	const asksV2 = (Number(body.flags ?? 0) & COMPONENTS_V2) !== 0;
	checkCard(body);
	// A message made without the flag cannot become a Components V2 message, nor the other way round.
	if (asksV2 && !v2)
		throw formError(
			"components[0]",
			"UNION_TYPE_CHOICES",
			"This message cannot hold Components V2",
		);
	if (v2 && (str(body.content) !== undefined || hasEmbeds(body)))
		throw legacyFieldsOnV2();
	if (components && body.components !== undefined)
		message.components = body.components;
	if (Array.isArray(body.embeds)) message.embeds = body.embeds;
	if (typeof body.content === "string") message.content = body.content;
}

function webhookOf(
	state: EmuState,
	id: string | undefined,
	token: string | undefined,
): EmuWebhook {
	const hook = id ? state.webhooks.get(id) : undefined;
	if (!hook) throw new HttpError(404, 10015, "Unknown Webhook");
	if (hook.token !== token)
		throw new HttpError(401, 50027, "Invalid Webhook Token");
	return hook;
}

/** Where a webhook speaks: its channel, or, with `thread_id`, a thread of that channel. */
function webhookTarget(
	state: EmuState,
	hook: EmuWebhook,
	query: URLSearchParams,
): EmuChannel {
	const threadId = query.get("thread_id");
	if (threadId === null) return channelOf(state, hook.channelId);
	const thread = channelOf(state, threadId);
	if (thread.parentId !== hook.channelId || !thread.thread)
		throw new HttpError(404, 10003, "Unknown Channel");
	return thread;
}

/** A webhook's own message in its channel; a message the webhook did not post is unknown to it. */
function webhookMessage(
	state: EmuState,
	ctx: Ctx,
): { hook: EmuWebhook; message: EmuMessage } {
	const hook = webhookOf(state, ctx.params[0], ctx.params[1]);
	const channel = webhookTarget(state, hook, ctx.query);
	const message = channel.messages.find(
		(entry) => entry.id === ctx.params[2] && entry.webhookId === hook.id,
	);
	if (!message) throw unknownMessage();
	return { hook, message };
}

export function messageRoutes(state: EmuState, pins: { at: number }): Route[] {
	return [
		[
			"GET",
			/^\/channels\/(\d+)\/webhooks$/,
			({ params }) => {
				const channel = channelOf(state, params[0]);
				return [...state.webhooks.values()]
					.filter((hook) => hook.channelId === channel.id)
					.map((hook) => ({
						id: hook.id,
						token: hook.token,
						name: hook.name,
						channel_id: hook.channelId,
						application_id: BOT_ID,
						user: { id: hook.userId },
					}));
			},
		],
		[
			"POST",
			/^\/channels\/(\d+)\/webhooks$/,
			({ params, body }) => {
				const channel = channelOf(state, params[0]);
				const name = str(body.name);
				if (!name) throw formError("name", "BASE_TYPE_REQUIRED", "required");
				if (FORBIDDEN_WORDS.test(name.normalize("NFKC")))
					throw formError(
						"name",
						"USERNAME_INVALID_CONTAINS",
						"Username cannot contain a reserved word",
					);
				const mine = [...state.webhooks.values()].filter(
					(hook) => hook.channelId === channel.id,
				);
				if (mine.length >= WEBHOOKS_PER_CHANNEL)
					throw new HttpError(
						400,
						30007,
						"Maximum number of webhooks reached (15)",
					);
				const hook: EmuWebhook = {
					id: newId(state),
					token: `emulated-webhook-token-${newId(state)}`,
					channelId: channel.id,
					name,
					userId: BOT_ID,
				};
				state.webhooks.set(hook.id, hook);
				return {
					id: hook.id,
					token: hook.token,
					name,
					channel_id: channel.id,
					application_id: BOT_ID,
					user: { id: BOT_ID },
				};
			},
		],
		[
			"POST",
			/^\/webhooks\/(\d+)\/([^/]+)$/,
			({ params, body, query }) => {
				const hook = webhookOf(state, params[0], params[1]);
				const channel = webhookTarget(state, hook, query);
				if (channel.type === 15)
					throw new HttpError(
						400,
						220001,
						"Webhooks posted to forum channels must have a thread_name or thread_id",
					);
				const files = Array.isArray(body.__files) ? body.__files : [];
				// Components are respected only when the request asks (`with_components`); the bot's own webhooks take every kind.
				const sent =
					query.get("with_components") === "true"
						? body
						: { ...body, components: undefined, flags: 0 };
				checkCard(sent);
				if (
					!str(body.content) &&
					files.length === 0 &&
					!sent.components &&
					!hasEmbeds(body)
				)
					throw new HttpError(400, 50006, "Cannot send an empty message");
				const username = str(body.username);
				if (username && FORBIDDEN_WORDS.test(username.normalize("NFKC")))
					throw formError(
						"username",
						"USERNAME_INVALID_CONTAINS",
						"Username cannot contain a reserved word",
					);
				const message = add(
					state,
					channel,
					{
						authorId: hook.id,
						webhookId: hook.id,
						...(username ? { username } : {}),
					},
					sent,
				);
				return messageJson(message);
			},
		],
		[
			"PATCH",
			/^\/webhooks\/(\d+)\/([^/]+)$/,
			({ params, body }) => {
				const hook = webhookOf(state, params[0], params[1]);
				if (typeof body.avatar === "string") hook.avatar = body.avatar;
				return { id: hook.id, name: hook.name };
			},
		],
		[
			"PATCH",
			/^\/webhooks\/(\d+)\/([^/]+)\/messages\/(\d+)$/,
			(ctx) => {
				const { message } = webhookMessage(state, ctx);
				// Components are respected only when the request asks (`with_components`).
				applyEdit(
					message,
					ctx.body,
					ctx.query.get("with_components") === "true",
				);
				const mentions = mentionsOf(ctx.body);
				if (mentions) message.allowedMentions = mentions;
				return messageJson(message);
			},
		],
		[
			"DELETE",
			/^\/webhooks\/(\d+)\/([^/]+)\/messages\/(\d+)$/,
			(ctx) => {
				const { hook, message } = webhookMessage(state, ctx);
				remove(channelOf(state, hook.channelId), message.id);
				return undefined;
			},
		],
		[
			"GET",
			/^\/channels\/(\d+)\/messages$/,
			({ params, query }) => {
				const limit = Math.min(100, Number(query.get("limit") ?? 50));
				return [...channelOf(state, params[0]).messages]
					.reverse()
					.slice(0, limit)
					.map(messageJson);
			},
		],
		[
			"POST",
			/^\/channels\/(\d+)\/messages$/,
			({ params, body }) => {
				const channel = channelOf(state, params[0]);
				if (
					channel.type === 1 &&
					channel.recipientId &&
					state.closedDirects.has(channel.recipientId)
				)
					throw new HttpError(403, 50007, "Cannot send messages to this user");
				// Posts of a forum are made with `POST /channels/{forum}/threads`.
				if (channel.type === 15)
					throw new HttpError(
						400,
						50024,
						"Cannot execute action on this channel type",
					);
				if (channel.thread?.archived) {
					// The bot's post wakes an archived thread, unless it is locked.
					if (channel.thread.locked)
						throw new HttpError(403, 50013, "Missing Permissions");
					channel.thread.archived = false;
				}
				checkCard(body);
				if (
					!str(body.content) &&
					body.components === undefined &&
					!hasEmbeds(body)
				)
					throw new HttpError(400, 50006, "Cannot send an empty message");
				return messageJson(add(state, channel, { authorId: BOT_ID }, body));
			},
		],
		[
			"GET",
			/^\/channels\/(\d+)\/messages\/pins$/,
			({ params, query }) => {
				const channel = channelOf(state, params[0]);
				const before = query.get("before");
				const limit = Math.min(50, Number(query.get("limit") ?? 50));
				const newest = [...channel.pins]
					.sort((a, b) => b.at - a.at)
					.filter((pin) => before === null || pin.at < Date.parse(before));
				return {
					items: newest.slice(0, limit).map((pin) => ({
						pinned_at: new Date(pin.at).toISOString(),
						message: messageJson(
							channel.messages.find(
								(m) => m.id === pin.messageId,
							) as EmuMessage,
						),
					})),
					has_more: newest.length > limit,
				};
			},
		],
		[
			"PUT",
			/^\/channels\/(\d+)\/messages\/pins\/(\d+)$/,
			({ params }) => {
				const channel = channelOf(state, params[0]);
				if (!channel.messages.some((message) => message.id === params[1]))
					throw unknownMessage();
				if (channel.pins.some((pin) => pin.messageId === params[1]))
					return undefined;
				if (channel.pins.length >= PIN_LIMIT)
					throw new HttpError(
						400,
						30003,
						"Maximum number of pins reached (250)",
					);
				pins.at += 1_000;
				channel.pins.push({
					messageId: params[1] as string,
					at: pins.at,
				});
				// Discord posts a notice, by the bot when the bot pinned, that points at the pinned message.
				if (state.pinNotices)
					add(
						state,
						channel,
						{
							authorId: BOT_ID,
							type: 6,
							referencedMessageId: params[1] as string,
						},
						{},
					);
				return undefined;
			},
		],
		[
			"DELETE",
			/^\/channels\/(\d+)\/messages\/pins\/(\d+)$/,
			({ params }) => {
				const channel = channelOf(state, params[0]);
				channel.pins = channel.pins.filter(
					(pin) => pin.messageId !== params[1],
				);
				return undefined;
			},
		],
		[
			"GET",
			/^\/channels\/(\d+)\/messages\/(\d+)$/,
			({ params }) => messageJson(find(state, params[0], params[1])),
		],
		[
			"PATCH",
			/^\/channels\/(\d+)\/messages\/(\d+)$/,
			({ params, body }) => {
				const message = find(state, params[0], params[1]);
				if (message.type !== 0)
					throw new HttpError(
						403,
						50021,
						"Cannot execute action on a system message",
					);
				if (message.authorId !== BOT_ID)
					throw new HttpError(
						403,
						50005,
						"Cannot edit a message authored by another user",
					);
				// Discord refuses the edit of a message in an archived thread; a message has no way to open it.
				if (channelOf(state, params[0]).thread?.archived)
					throw new HttpError(400, 50083, "Thread is archived");
				applyEdit(message, body, true);
				return messageJson(message);
			},
		],
		[
			"DELETE",
			/^\/channels\/(\d+)\/messages\/(\d+)$/,
			({ params }) => {
				const message = find(state, params[0], params[1]);
				remove(channelOf(state, params[0]), message.id);
				return undefined;
			},
		],
	];
}

function find(
	state: EmuState,
	channelId: string | undefined,
	messageId: string | undefined,
): EmuMessage {
	const message = channelOf(state, channelId).messages.find(
		(entry) => entry.id === messageId,
	);
	if (!message) throw unknownMessage();
	return message;
}

function remove(channel: EmuChannel, messageId: string): void {
	channel.messages = channel.messages.filter(
		(message) => message.id !== messageId,
	);
	channel.pins = channel.pins.filter((pin) => pin.messageId !== messageId);
}
