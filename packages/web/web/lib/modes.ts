import type { RoomMode } from "../../src/api-types.ts";
import { api, messageOf } from "./api.ts";
import { toast } from "./toast.ts";

/** Changes a room's mode; a refusal shows as a notice, so the promise settles either way. */
export const changeMode = (
	room: string,
	change: Partial<RoomMode>,
): Promise<void> =>
	api.setMode(room, change).then(
		() => undefined,
		(failure) => toast(messageOf(failure), "danger"),
	);
