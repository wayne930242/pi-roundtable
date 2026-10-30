import { useState } from "react";
import { useSelector } from "../lib/app-store.ts";
import { followFocus, speakerOf } from "../lib/dialogue.ts";
import { speakerOfRound } from "../lib/round-view.ts";
import type { SeatMenuRequest, TableHandle } from "../table/entry.ts";
import { DialogueBox, useRoomLine } from "./dialogue-box.tsx";
import { OrderStrip } from "./order-strip.tsx";
import { RoundTable } from "./round-table.tsx";

/**
 * Where the camera of a group scene is: on the member the round says speaks now, else on whoever
 * said the newest line, or on the member a person turned it to by hand, until the next line or the
 * next speaker comes. `look` turns it (null: the whole ring).
 */
export function useGroupFocus(roomKey: string, members: readonly string[]) {
	const { line } = useRoomLine(roomKey);
	const speaking = useSelector((state) =>
		speakerOfRound(state.rooms[roomKey]?.round),
	);
	const [manual, setManual] = useState<{
		lineId: string | undefined;
		member: string | null;
	}>();
	// A hand-turned camera stays for the beat it was turned in: the newest line and the one who speaks.
	const beat = `${line?.id ?? ""}|${speaking ?? ""}`;
	const speaker =
		speaking !== undefined && members.includes(speaking)
			? speaking
			: speakerOf(line, members);
	const focus = followFocus(speaker, beat, manual);
	const look = (member: string | null) => setManual({ lineId: beat, member });
	return { focus, look };
}

/**
 * A group's members at their podiums with the group room's dialogue box over the scene. A seat the
 * person taps turns the camera to that member; nothing here ever takes the focus of the message box.
 * The room's own page keeps streaming its progress here, so the box does not ask for it, unless
 * `streams` says the page does not.
 */
export function GroupStage(props: {
	roomKey: string;
	members: readonly string[];
	focus: string | null;
	onLook(member: string | null): void;
	streams?: boolean;
	onHandle?(handle: TableHandle | undefined): void;
	onSeatMenu?(request: SeatMenuRequest): void;
}) {
	const { roomKey, members } = props;
	return (
		<div className="table-frame room-scene" data-focused="">
			<RoundTable
				members={members}
				groupRoom={roomKey}
				variant="full"
				focus={props.focus}
				onFocus={props.onLook}
				onSeat={props.onLook}
				{...(props.onHandle ? { onHandle: props.onHandle } : {})}
				{...(props.onSeatMenu ? { onSeatMenu: props.onSeatMenu } : {})}
			/>
			<DialogueBox
				roomKey={roomKey}
				open
				streams={props.streams ?? false}
				strip={<OrderStrip roomKey={roomKey} />}
			/>
		</div>
	);
}

/**
 * A group room as the round table scene: the group's members stand at their podiums, the whole
 * conversation runs in the dialogue box, and the camera turns to whoever speaks. While the owner
 * speaks it rests on the whole ring.
 */
export function GroupScene(props: {
	roomKey: string;
	members: readonly string[];
}) {
	const { focus, look } = useGroupFocus(props.roomKey, props.members);
	return (
		<GroupStage
			roomKey={props.roomKey}
			members={props.members}
			focus={focus}
			onLook={look}
		/>
	);
}
