import type { ChannelKey } from "pi-roundtable";
import type { ClientFrame, RefusalCode } from "../api-types.ts";
import type { Viewer } from "../web-app.ts";
import type { Answerer, OwnerDesk } from "./desk.ts";
import type { SocketRouteOptions } from "./socket-options.ts";

/**
 * An answer to a card: who may give it is the card's own audience (the turn's speaker, the
 * named approvers, the owners where the scope escalates), which the room's access cannot widen.
 * A card of a host room is first something the person must be able to read; a card of an agent
 * room is the owners'.
 */
export async function answerCard(
	options: Pick<SocketRouteOptions, "desk" | "registry">,
	who: Answerer,
	frame: Extract<
		ClientFrame,
		{ type: "approval" | "answer" | "answers" | "cancel" }
	>,
): Promise<RefusalCode | undefined> {
	const { desk, registry } = options;
	const room = desk.roomOf(frame.prompt);
	if (room !== undefined) {
		if (registry.isHostRoom(room)) {
			const viewer: Viewer = {
				principalId: who.principalId,
				speakerId: who.speakerId,
				tier: who.tier,
				roles: who.roles ?? [],
				name: who.name,
			};
			if (!(await registry.access.read(viewer, room as ChannelKey)))
				return "unknown_prompt";
		} else if (who.tier !== "owner") return "forbidden";
	}
	switch (frame.type) {
		case "approval":
			return needsActor(desk, who, frame.prompt)
				? "forbidden"
				: desk.approve(who, frame.prompt, frame.approved);
		case "answer":
			return needsActor(desk, who, frame.prompt)
				? "forbidden"
				: desk.answer(who, frame.prompt, frame.answer);
		case "answers":
			return needsActor(desk, who, frame.prompt)
				? "forbidden"
				: desk.answers(who, frame.prompt, frame.answers, frame.note);
		case "cancel":
			return desk.cancel(who, frame.prompt);
	}
}

/**
 * Whether this answer cannot be taken: a late card's answer starts a turn written as the
 * answerer, which needs the actor their credential vouched for. Refused up front, the card
 * stays open for someone who has one rather than closing on an answer that goes nowhere.
 */
function needsActor(desk: OwnerDesk, who: Answerer, prompt: string): boolean {
	return !who.actor && desk.isLate(prompt);
}
