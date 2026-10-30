import type { HostCardView, RoomMessage } from "../api-types.ts";
import { bad, bodyOf, HttpError } from "../app/api-http.ts";
import { PAGE_LIMIT } from "../app/room-log.ts";
import { json } from "../http.ts";
import type {
	ActionResult,
	FormValues,
	HostRoomKind,
	RoomHeader,
	RouteArea,
	Viewer,
} from "../web-app.ts";
import { checkActions, safeLink } from "./forms.ts";
import { actInRoom, hostRoomOf } from "./frames.ts";
import { asRoom, type HostContext } from "./host-context.ts";
import {
	cardView,
	checkPicture,
	readsOf,
	withExpiredFiles,
} from "./room-views.ts";
import type {
	HostActionResult,
	HostHeaderView,
	HostListView,
	HostMessagesView,
	HostPageView,
	HostRoomSummaryView,
	HostRoomView,
} from "./views.ts";

/** How many messages a room opens with. */
const OPEN_LIMIT = 50;
/** The largest JSON body an action reads: a form's values. */
const ACT_BODY_BYTES = 512 * 1024;

const nothing = () => new HttpError(404, "There is no such room.");

/** The query of a request's URL. */
export const queryOf = (request: Request): URLSearchParams =>
	URL.parse(request.url)?.searchParams ?? new URLSearchParams();

/** An action's answer as the page is sent it: `open` and `url` are kept only when they are places the page may go. */
export function resultView(result: ActionResult): HostActionResult {
	if (!result.ok)
		return {
			ok: false,
			error: String(result.error).slice(0, 1_000),
			...(result.field === undefined ? {} : { field: result.field }),
		};
	const open =
		result.open && "room" in result.open
			? {
					room: String(result.open.room),
					...(result.open.message === undefined
						? {}
						: { message: result.open.message }),
				}
			: result.open && "page" in result.open
				? {
						page: String(result.open.page),
						...(result.open.query ? { query: { ...result.open.query } } : {}),
					}
				: undefined;
	return {
		ok: true,
		...(result.notice === undefined
			? {}
			: { notice: String(result.notice).slice(0, 1_000) }),
		...(open ? { open } : {}),
		...(result.url !== undefined && safeLink(result.url)
			? { url: result.url }
			: {}),
	};
}

/** The values of an action's `input`: text, or a list of text, by field name. */
export function inputOf(value: unknown): FormValues {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw bad("input must be an object.");
	const input: Record<string, string | readonly string[]> = {};
	for (const [name, field] of Object.entries(value)) {
		if (typeof field === "string") input[name] = field;
		else if (
			Array.isArray(field) &&
			field.every((one) => typeof one === "string")
		)
			input[name] = field as string[];
		else throw bad("input holds text or lists of text.");
	}
	return input;
}

/** A host's header, cut down to what the page draws and checked. */
function headerView(header: RoomHeader): HostHeaderView {
	checkActions(header.actions, "a room's header");
	for (const field of header.fields)
		if (field.link !== undefined && !safeLink(field.link))
			throw new Error(
				`a header link ${JSON.stringify(field.link)} must be https or a path of this origin`,
			);
	return {
		title: String(header.title).slice(0, 200),
		fields: header.fields.slice(0, 40).map((field) => ({
			label: String(field.label).slice(0, 120),
			value: String(field.value).slice(0, 2_000),
			...(field.link ? { link: field.link } : {}),
		})),
		actions: structuredClone([...header.actions]),
		...(header.banner
			? {
					banner: {
						tone: header.banner.tone,
						text: String(header.banner.text).slice(0, 2_000),
					},
				}
			: {}),
	};
}

/**
 * The REST of the host's rooms below `api/host/`: the list of a kind, a room as it opens, older
 * messages, and a press on a button. The authority is the kind's `access`, asked again on every
 * request; to anyone it gives nothing, a room, a kind and a message are all 404.
 */
export function hostArea(ctx: HostContext): RouteArea {
	return {
		area: "host",
		handle: async (request, parts, { viewer }) => {
			const [kindName, id, action] = parts;
			const { method } = request;
			if (!kindName) throw nothing();
			if (!id) {
				if (method !== "GET") throw new HttpError(405, "Method not allowed.");
				return json(await list(ctx, viewer, kindName, request));
			}
			const room = `${ctx.surface}:${kindName}.${id}`;
			if (!hostRoomOf(ctx, room)) throw nothing();
			if (!action && method === "GET")
				return json(await open(ctx, viewer, room));
			if (action === "messages" && method === "GET" && parts.length === 3)
				return json(await older(ctx, viewer, room, request));
			if (action === "act" && method === "POST" && parts.length === 3)
				return act(ctx, viewer, room, request);
			throw new HttpError(404, "There is no such API.");
		},
	};
}

async function list(
	ctx: HostContext,
	viewer: Viewer,
	kindName: string,
	request: Request,
): Promise<HostListView> {
	const kind = ctx.registry.kind(kindName);
	if (!kind) throw nothing();
	const params = queryOf(request);
	const filter = params.get("filter");
	const cursor = params.get("cursor");
	const given = await kind.list(viewer, {
		...(filter === null ? {} : { filter }),
		...(cursor === null ? {} : { cursor }),
	});
	ctx.listed.set(viewer.principalId, kindName, given !== undefined);
	if (!given) throw nothing();
	const rooms: HostRoomSummaryView[] = [];
	for (const summary of given.rooms) {
		const key = `${ctx.surface}:${kindName}.${summary.id}`;
		if (!hostRoomOf(ctx, key)) {
			ctx.logger.warn(
				{ kind: kindName },
				"a room of a kind was left out of its list: its id is not 8 to 64 letters, digits, - or _",
			);
			continue;
		}
		let picture = summary.picture;
		if (picture) {
			try {
				picture = checkPicture(picture);
			} catch {
				picture = undefined;
			}
		}
		rooms.push({
			id: summary.id,
			key,
			title: String(summary.title).slice(0, 200),
			...(summary.subtitle === undefined
				? {}
				: { subtitle: String(summary.subtitle).slice(0, 300) }),
			...(picture ? { picture } : {}),
			...(summary.lastAt === undefined ? {} : { lastAt: summary.lastAt }),
			...(summary.attention ? { attention: true } : {}),
		});
	}
	// The app counts what is unread for this person; a number the host gave is replaced.
	const unread = await ctx.reads.unread(
		viewer.principalId,
		rooms.map((room) => room.key),
	);
	return {
		kind: kindName,
		label: kind.label,
		rooms: rooms.map((room) => {
			const count = unread.get(room.key);
			return count ? { ...room, unread: count } : room;
		}),
		...(given.cursor === undefined ? {} : { cursor: given.cursor }),
	};
}

async function headerOf(
	ctx: HostContext,
	kind: HostRoomKind,
	viewer: Viewer,
	id: string,
): Promise<HostHeaderView> {
	try {
		const header = await kind.header?.(viewer, id);
		if (header) return headerView(header);
	} catch (error) {
		ctx.logger.warn(
			{ kind: kind.kind, err: error },
			"a room's header could not be read",
		);
	}
	return { title: id, fields: [], actions: [] };
}

async function open(
	ctx: HostContext,
	viewer: Viewer,
	room: string,
): Promise<HostRoomView> {
	const found = hostRoomOf(ctx, room);
	if (!found) throw nothing();
	const access = await ctx.access.of(viewer, room);
	if (!access) throw nothing();
	const cursor = await ctx.reads.cursorOf(room, viewer.principalId);
	const [header, page, stored] = await Promise.all([
		headerOf(ctx, found.kind, viewer, found.id),
		ctx.log.page(room, undefined, OPEN_LIMIT),
		ctx.cards.list(room),
	]);
	const cards: HostCardView[] = await Promise.all(
		stored.map((card) => cardView(viewer, found, access, card)),
	);
	return {
		room,
		kind: found.kind.kind,
		id: found.id,
		access: { send: [...access.send], act: access.act },
		header,
		messages: withExpiredFiles(page.messages, ctx.files),
		more: page.more,
		cards,
		reads: await readsOf(ctx.reads, room, viewer.principalId, ctx.nameOf),
		...(cursor === undefined ? {} : { cursor }),
	};
}

async function older(
	ctx: HostContext,
	viewer: Viewer,
	room: string,
	request: Request,
): Promise<HostMessagesView> {
	if (!(await ctx.access.of(viewer, room))) throw nothing();
	const params = queryOf(request);
	const before = params.get("before");
	const limit = params.get("limit");
	const beforeId = before === null ? undefined : Number(before);
	const count = limit === null ? OPEN_LIMIT : Number(limit);
	if (
		(beforeId !== undefined && !Number.isInteger(beforeId)) ||
		!Number.isInteger(count) ||
		count < 1 ||
		count > PAGE_LIMIT
	)
		throw bad("before and limit must be whole numbers.");
	const page = await ctx.log.page(room, beforeId, count);
	const messages: RoomMessage[] = withExpiredFiles(page.messages, ctx.files);
	return {
		messages,
		more: page.more,
		reads: await readsOf(ctx.reads, room, viewer.principalId, ctx.nameOf),
	};
}

async function act(
	ctx: HostContext,
	viewer: Viewer,
	room: string,
	request: Request,
): Promise<Response> {
	const body = await bodyOf(request, ACT_BODY_BYTES);
	const { action, card } = body;
	if (typeof action !== "string" || action === "" || action.length > 200)
		throw bad("action must be text.");
	if (card !== undefined && (typeof card !== "string" || card.length > 200))
		throw bad("card must be text.");
	const outcome = await actInRoom(ctx, viewer, asRoom(room), {
		action,
		...(card === undefined ? {} : { card }),
		input: inputOf(body.input),
	});
	if ("refused" in outcome) {
		if (outcome.refused === "unknown") throw nothing();
		throw new HttpError(403, "This is not yours to do.");
	}
	return json(resultView(outcome.result));
}

/** The most query parameters a page is given, and the longest value. */
const MAX_QUERY = 20;
const MAX_QUERY_VALUE = 500;

/**
 * The REST of the host's pages below `api/pages/`: a page's view and the press of one of its
 * actions. A page the viewer may not see is 404, as `visible` says it afresh on every call.
 */
export function pagesArea(ctx: HostContext): RouteArea {
	return {
		area: "pages",
		handle: async (request, parts, { viewer }) => {
			const [id, action] = parts;
			const { method } = request;
			if (!id) throw new HttpError(404, "There is no such page.");
			if (!action && method === "GET") {
				const query: Record<string, string> = {};
				let count = 0;
				for (const [key, value] of queryOf(request)) {
					count += 1;
					if (count > MAX_QUERY || value.length > MAX_QUERY_VALUE)
						throw bad("The page's query is too long.");
					query[key] = value;
				}
				const view = await ctx.pages.view(viewer, id, query);
				if (!view) throw new HttpError(404, "There is no such page.");
				return json(view satisfies HostPageView);
			}
			if (action === "act" && method === "POST" && parts.length === 2) {
				const body = await bodyOf(request, ACT_BODY_BYTES);
				if (
					typeof body.action !== "string" ||
					body.action === "" ||
					body.action.length > 200
				)
					throw bad("action must be text.");
				const outcome = await ctx.pages.act(viewer, id, {
					action: body.action,
					input: inputOf(body.input),
				});
				if ("refused" in outcome)
					throw new HttpError(404, "There is no such page.");
				return json(resultView(outcome.result));
			}
			throw new HttpError(404, "There is no such API.");
		},
	};
}
