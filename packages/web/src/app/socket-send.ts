import {
	type ClientFrame,
	MAX_MESSAGE_CHARS,
	type RefusalCode,
} from "../api-types.ts";
import type { Answerer } from "./desk.ts";
import { keepNote, say } from "./say.ts";
import type { SocketRouteOptions } from "./socket-options.ts";
import type { AppSocket } from "./sockets.ts";

/** An owner's message to an agent room: checked, then said or kept as a note; each refusal says why. */
export async function sendMessage(
	options: SocketRouteOptions,
	connection: AppSocket,
	who: Answerer,
	frame: Extract<ClientFrame, { type: "send" }>,
	refuse: (code: RefusalCode) => void,
): Promise<void> {
	const { rooms, uploads, surface, sockets, logger } = options;
	// The agent rooms are the owners', and they take only turns.
	if (who.tier !== "owner") return refuse("forbidden");
	// A note is for the other people who read the rooms; where nobody else does, it is no frame.
	const note = frame.mode === "note";
	if (note && !(await rooms.notesOn())) return refuse("bad_frame");
	const room = await rooms.resolve(frame.room);
	if (!room) return refuse("unknown_room");
	if (room.readOnly) return refuse("read_only");
	const text = frame.text.trim();
	if (text.length > MAX_MESSAGE_CHARS) return refuse("too_long");
	const ids = frame.uploads ?? [];
	if (text === "" && ids.length === 0) return refuse("empty");
	// Without the actor the credential vouched for, the router cannot tell whose message it is;
	// a note goes to no router.
	if (!note && !who.actor) return refuse("forbidden");
	const files = uploads.claim(ids, who.principalId);
	if (!files) return refuse("unknown_upload");
	if (!surface.started) return refuse("not_accepted");
	try {
		if (note)
			await keepNote(options, connection, who, room.key, frame.id, text, files);
		else
			await say(options, room.key, who, text, files, connection, (message) =>
				sockets.deliver(
					{ type: "accepted", id: frame.id, room: room.key, message },
					{ connection },
				),
			);
	} catch (error) {
		logger.warn({ room: room.key, err: error }, "an app message was not taken");
		refuse("not_accepted");
	}
}
