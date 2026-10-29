import { api, messageOf } from "./api.ts";
import { store } from "./app-store.ts";
import { toast } from "./toast.ts";

/**
 * Mutes or unmutes a room's push for every owner and device, and shows it in the lists at once.
 * A refusal shows as a notice; the answer says whether the room is muted now as the server has it.
 */
export async function setRoomMuted(
	room: string,
	muted: boolean,
): Promise<boolean> {
	try {
		const answer = await api.setMute(room, muted);
		store.dispatch({ type: "room_muted", room, muted: answer.muted });
		return true;
	} catch (failure) {
		toast(messageOf(failure), "danger");
		return false;
	}
}
