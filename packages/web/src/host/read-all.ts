import type { Viewer } from "../web-app.ts";
import { hostRoomOf, readableAudience } from "./frames.ts";
import type { HostContext } from "./host-context.ts";
import type { MovedMark } from "./reads.ts";

/** The most rooms one bulk read, or one undo of it, names. */
export const MAX_READ_ALL = 500;

/**
 * Reads every one of `rooms` the viewer may read now up to its newest message, and tells the
 * others: each room's readers see the new mark (as for a single `read` frame), and the viewer's own
 * pages, wherever they follow the room or not, hear of it too. A room the viewer may not read, or
 * that is none, is skipped as if it were not named. Gives the cursors that moved.
 */
export async function readAll(
	ctx: HostContext,
	viewer: Viewer,
	rooms: readonly string[],
): Promise<MovedMark[]> {
	const audiences = new Map<
		string,
		Awaited<ReturnType<typeof readableAudience>>
	>();
	await Promise.all(
		[...new Set(rooms)].map(async (room) => {
			audiences.set(room, await readableAudience(ctx, viewer, room));
		}),
	);
	const allowed = [...audiences].flatMap(([room, audience]) =>
		audience ? [room] : [],
	);
	const moved = await ctx.reads.advanceAll(viewer.principalId, allowed);
	for (const mark of moved) {
		const audience = audiences.get(mark.room);
		if (!audience) continue;
		const frame = {
			type: "read",
			room: mark.room,
			principal: viewer.principalId,
			name: viewer.name,
			upTo: mark.to,
			at: mark.at,
		} as const;
		ctx.sockets.deliver(frame, audience);
		// A host room reaches only the pages that follow it; the viewer's other pages show its count in a list.
		if ("room" in audience)
			ctx.sockets.deliver(frame, { principal: viewer.principalId });
	}
	return moved;
}

/**
 * Puts back cursors that `readAll` moved, for the rooms the viewer may still read and whose cursor
 * is still where it left it. The viewer's pages read their lists again to find the counts back.
 * Gives the rooms put back.
 */
export async function unreadAll(
	ctx: HostContext,
	viewer: Viewer,
	moves: readonly { room: string; from: number; to: number }[],
): Promise<string[]> {
	const allowed: { room: string; from: number; to: number }[] = [];
	await Promise.all(
		moves.map(async (move) => {
			if (await readableAudience(ctx, viewer, move.room)) allowed.push(move);
		}),
	);
	const restored = await ctx.reads.rewind(viewer.principalId, allowed);
	const kinds = new Set<string>();
	for (const room of restored) {
		const kind = hostRoomOf(ctx, room)?.kind.kind;
		if (kind) kinds.add(kind);
	}
	for (const kind of kinds)
		ctx.sockets.deliver(
			{ type: "list_changed", kind },
			{ principal: viewer.principalId },
		);
	return restored;
}
