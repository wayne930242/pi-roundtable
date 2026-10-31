import { useState } from "react";
import { followFocus, sceneSpeaker } from "../lib/dialogue.ts";
import { useDialogueFolded } from "../lib/table-view.ts";
import { useVoices } from "../lib/voices.ts";
import type { SeatMenuRequest, TableHandle } from "../table/entry.ts";
import { DialogueBox, useRoomLine } from "./dialogue-box.tsx";
import { OrderStrip } from "./order-strip.tsx";
import { RoundTable } from "./round-table.tsx";

/**
 * Where the camera of a group scene is: on the member whose words the dialogue box is typing out,
 * and after they stand whole, still on whoever said them, until the next member's words start; a
 * member who only thinks does not turn it, as it does not light their seat. A person may turn it by
 * hand until the next line or speaker comes. `look` turns it (null: the whole ring).
 */
export function useGroupFocus(roomKey: string, members: readonly string[]) {
	const { line } = useRoomLine(roomKey);
	const held = useVoices()[roomKey];
	const [manual, setManual] = useState<{
		lineId: string | undefined;
		member: string | null;
	}>();
	// A hand-turned camera stays for the beat it was turned in: the newest line and the one who speaks.
	const speaker = sceneSpeaker(held, line, members);
	const beat = `${line?.id ?? ""}|${speaker ?? ""}`;
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
	/** A message sent from the box closes a phone's keyboard. */
	blurAfterSend?: boolean;
	onHandle?(handle: TableHandle | undefined): void;
	onSeatMenu?(request: SeatMenuRequest): void;
}) {
	const { roomKey, members } = props;
	// A folded box is a bar: the scene takes the height it gave back.
	const [folded] = useDialogueFolded();
	return (
		<div
			className="table-frame room-scene"
			data-focused=""
			data-folded={folded || undefined}
		>
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
				blurAfterSend={props.blurAfterSend === true}
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
