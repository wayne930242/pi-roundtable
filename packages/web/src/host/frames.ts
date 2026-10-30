import type { ActorFacts, InboundMessage } from "pi-roundtable";
import {
	type ClientFrame,
	MAX_MESSAGE_CHARS,
	type RefusalCode,
} from "../api-types.ts";
import type { AppSocket, Audience } from "../app/sockets.ts";
import type {
	ActionResult,
	FormSpec,
	FrameContext,
	HostAction,
	Viewer,
} from "../web-app.ts";
import { checkInput } from "./forms.ts";
import { asRoom, type HostContext } from "./host-context.ts";
import { buttonsFor, type FoundRoom } from "./room-views.ts";

/** The most host rooms one socket follows. */
export const MAX_SUBSCRIPTIONS = 200;

/** An id of a host room: what follows the dot of `<surface>:<kind>.<id>`. */
const ROOM_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The host room a key names, when its kind is registered and its id has the shape a room's has. */
export function hostRoomOf(
	ctx: Pick<HostContext, "registry">,
	key: string,
): FoundRoom | undefined {
	const found = ctx.registry.hostKindOf(key);
	return found && ROOM_ID.test(found.id) ? found : undefined;
}

/** Why an act did not reach the host. */
export type ActRefusal = "unknown" | "forbidden";

export type ActOutcome = { result: ActionResult } | { refused: ActRefusal };

/**
 * One press of a button or submit of a form in a host room: the viewer may read and act, the
 * button is one this card offers them (or an action of the room's header), and the form's input is
 * what the form asks for. Only then does the host hear of it, and the host decides what it means.
 */
export async function actInRoom(
	ctx: HostContext,
	viewer: Viewer,
	room: string,
	press: {
		action: string;
		card?: string;
		input?: Readonly<Record<string, string | readonly string[]>>;
	},
): Promise<ActOutcome> {
	const found = hostRoomOf(ctx, room);
	if (!found) return { refused: "unknown" };
	const access = await ctx.access.of(viewer, room);
	if (!access) return { refused: "unknown" };
	if (!access.act) return { refused: "forbidden" };
	let offered: readonly HostAction[];
	if (press.card !== undefined) {
		const card = await ctx.cards.get(room, press.card);
		if (!card) return { refused: "unknown" };
		offered = await buttonsFor(viewer, found, access, card);
	} else {
		const header = await found.kind
			.header?.(viewer, found.id)
			.catch((error: unknown) => {
				ctx.logger.warn(
					{ kind: found.kind.kind, err: error },
					"a room's header could not be read",
				);
				return undefined;
			});
		offered = header?.actions ?? [];
	}
	const button = offered.find((one) => one.id === press.action);
	if (!button) return { refused: "forbidden" };
	if (!found.kind.act) return { refused: "unknown" };
	const checked = checkInput(
		button.form as FormSpec | undefined,
		press.input ?? {},
	);
	if (!checked.ok)
		return {
			result: {
				ok: false,
				error: checked.error,
				...(checked.field ? { field: checked.field } : {}),
			},
		};
	let result: ActionResult;
	try {
		result = await found.kind.act(
			viewer,
			found.id,
			{
				action: press.action,
				...(press.card === undefined ? {} : { card: press.card }),
			},
			checked.values,
		);
	} catch (error) {
		ctx.logger.warn(
			{ kind: found.kind.kind, err: error },
			"a host action failed",
		);
		result = { ok: false, error: "The action could not be done." };
	}
	ctx.events?.action?.({
		kind: "act",
		actor: viewer.speakerId,
		principalId: viewer.principalId,
		channel: asRoom(room),
		ok: result.ok,
		at: new Date(ctx.now()),
	});
	return { result };
}

/** The audience a room's `read` frames go to: a host room's readers, or the owners for an agent room. */
export const readAudience = (
	ctx: Pick<HostContext, "registry">,
	room: string,
): Audience => (ctx.registry.isHostRoom(room) ? { room } : { owners: true });

/** Registers the handlers of the frames host rooms take. */
export function installFrames(ctx: HostContext): void {
	const { registry } = ctx;

	registry.onFrame(
		"subscribe",
		async ({ frame, viewer, connection, refuse }) => {
			if (!hostRoomOf(ctx, frame.room)) return refuse("unknown_room");
			if (
				!connection.subscriptions.has(frame.room) &&
				connection.subscriptions.size >= MAX_SUBSCRIPTIONS
			)
				return refuse("not_accepted");
			if (!(await ctx.access.read(viewer, asRoom(frame.room))))
				return refuse("unknown_room");
			connection.subscriptions.add(frame.room);
			// A card that opened before the reader came is theirs to see, once they may read the room.
			for (const { room, frame: card } of ctx.desk.openFrames())
				if (room === frame.room)
					ctx.sockets.deliver(card, {
						connection,
						audience: { room: frame.room },
					});
		},
	);

	registry.onFrame("unsubscribe", async ({ frame, connection }) => {
		connection.subscriptions.delete(frame.room);
		if (connection.focus === frame.room) connection.focus = undefined;
	});

	registry.onFrame("act", async ({ frame, viewer, refuse }) => {
		if (frame.page !== undefined) {
			const outcome = await ctx.pages.act(viewer, frame.page, {
				action: frame.action,
				...(frame.input ? { input: frame.input } : {}),
			});
			if ("refused" in outcome) return refuse("forbidden", frame.id);
			if (!outcome.result.ok) return refuse("not_accepted", frame.id);
			return;
		}
		const outcome = await actInRoom(ctx, viewer, frame.room ?? "", {
			action: frame.action,
			...(frame.card === undefined ? {} : { card: frame.card }),
			...(frame.input ? { input: frame.input } : {}),
		});
		if ("refused" in outcome)
			return refuse(
				outcome.refused === "unknown" ? "unknown_room" : "forbidden",
				frame.id,
			);
		if (!outcome.result.ok) refuse("not_accepted", frame.id);
	});

	registry.onFrame("read", async ({ frame, viewer, connection, refuse }) => {
		const audience = await readableAudience(ctx, viewer, frame.room);
		if (!audience) return refuse("unknown_room");
		const mark = await ctx.reads.advance(
			frame.room,
			viewer.principalId,
			frame.upTo,
		);
		if (!mark) return;
		ctx.sockets.deliver(
			{
				type: "read",
				room: frame.room,
				principal: viewer.principalId,
				name: viewer.name,
				upTo: mark.upTo,
				at: mark.at,
			},
			audience,
		);
		void connection;
	});

	registry.onFrame("hostSend", async (context) => hostSend(ctx, context));

	registry.onFrame("hostStop", async ({ frame, viewer, refuse }) => {
		if (!hostRoomOf(ctx, frame.room)) return refuse("unknown_room");
		const access = await ctx.access.of(viewer, frame.room);
		if (!access) return refuse("unknown_room");
		if (!access.send.includes("turn")) return refuse("forbidden");
		ctx.conversations.stop(asRoom(frame.room));
	});
}

/**
 * Who a read frame of this room is shown to when the viewer may read it now: a host room's readers
 * (asked of the kind), or, for an agent or thread room, the owners. Undefined when the viewer may not.
 */
export async function readableAudience(
	ctx: HostContext,
	viewer: Viewer,
	room: string,
): Promise<Audience | undefined> {
	if (ctx.registry.isHostRoom(room)) {
		if (!hostRoomOf(ctx, room)) return undefined;
		return (await ctx.access.read(viewer, asRoom(room))) ? { room } : undefined;
	}
	if (viewer.tier !== "owner") return undefined;
	return (await ctx.rooms.resolve(room)) ? { owners: true } : undefined;
}

/** A viewer's message to a host room: stored and shown, and a `turn` is also handed to the room's claim. */
async function hostSend(
	ctx: HostContext,
	{
		frame,
		viewer,
		connection,
		refuse,
	}: FrameContext<Extract<ClientFrame, { type: "send" }>>,
): Promise<void> {
	const reject = (code: RefusalCode) => refuse(code, frame.id);
	const found = hostRoomOf(ctx, frame.room);
	if (!found) return reject("unknown_room");
	const access = await ctx.access.of(viewer, frame.room);
	if (!access) return reject("unknown_room");
	const mode = frame.mode ?? "turn";
	if (!access.send.includes(mode)) return reject("forbidden");
	const text = frame.text.trim();
	if (text.length > MAX_MESSAGE_CHARS) return reject("too_long");
	const ids = frame.uploads ?? [];
	if (text === "" && ids.length === 0) return reject("empty");
	// A turn is written as the person; without the actor their credential vouched for, it cannot be.
	if (mode === "turn" && !connection.actor) return reject("forbidden");
	const files = ctx.uploads.claim(ids, viewer.principalId);
	if (!files) return reject("unknown_upload");
	if (!ctx.app.started) return reject("not_accepted");
	if (found.kind.send) {
		let verdict: "accepted" | { refused: string };
		try {
			verdict = await found.kind.send(viewer, found.id, { mode, text, files });
		} catch (error) {
			ctx.logger.warn(
				{ kind: found.kind.kind, err: error },
				"a kind's send failed",
			);
			return reject("not_accepted");
		}
		if (verdict !== "accepted") return reject("not_accepted");
	}
	const expiresAt = found.kind.retention
		? ctx.now() + found.kind.retention.fileDays * 86_400_000
		: undefined;
	const message = await ctx.app.publish(
		{
			room: asRoom(frame.room),
			kind: "owner",
			principalId: viewer.principalId,
			author: viewer.name,
			text,
			files: [...files],
			authorKind: "member",
		},
		connection,
	);
	ctx.uploads.use(
		files.map((file) => file.id),
		{ room: frame.room, ...(expiresAt === undefined ? {} : { expiresAt }) },
	);
	ctx.sockets.deliver(
		{ type: "accepted", id: frame.id, room: frame.room, message },
		{ connection },
	);
	// What a person sends is read by them, and the others see the room has moved.
	const mark = await ctx.reads.advance(
		frame.room,
		viewer.principalId,
		message.id,
	);
	if (mark)
		ctx.sockets.deliver(
			{
				type: "read",
				room: frame.room,
				principal: viewer.principalId,
				name: viewer.name,
				upTo: mark.upTo,
				at: mark.at,
			},
			{ room: frame.room },
		);
	if (mode !== "turn" || !connection.actor) return;
	// The router never records a lower tier from these facts: the app is not the authority on roles.
	const actor: ActorFacts = {
		...connection.actor,
		surface: ctx.surface,
		partial: true,
	};
	const inbound: InboundMessage = {
		channel: asRoom(frame.room),
		messageId: `app-${message.id}`,
		actor,
		authorId: viewer.principalId,
		authorName: viewer.name,
		authorIsBot: false,
		isDirect: false,
		mentionsBot: false,
		repliesToBot: false,
		text,
		attachments: files.map((file) => ctx.uploads.refOf(file)),
	};
	try {
		ctx.app.deliver(inbound);
	} catch (error) {
		ctx.logger.warn(
			{ room: frame.room, err: error },
			"a host room turn was not delivered",
		);
	}
}

/** The connection of a frame, for the pieces that need its socket. */
export type { AppSocket };
