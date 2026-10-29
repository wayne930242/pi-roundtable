import { useState } from "react";
import { followFocus, speakerOf } from "../lib/dialogue.ts";
import { DialogueBox, useRoomLine } from "./dialogue-box.tsx";
import { RoundTable } from "./round-table.tsx";

/**
 * A group room as the round table scene: the group's members stand at their podiums, the whole
 * conversation runs in the dialogue box, and the camera turns to whoever speaks. While the owner
 * speaks it rests on the whole ring. A seat the person taps turns the camera to that member until
 * the next line comes; nothing here ever takes the focus of the message box. The room's own page
 * keeps streaming its progress here, so the box does not ask for it.
 */
export function GroupScene(props: {
	roomKey: string;
	members: readonly string[];
}) {
	const { roomKey, members } = props;
	const { line } = useRoomLine(roomKey);
	const [manual, setManual] = useState<{
		lineId: string | undefined;
		member: string | null;
	}>();
	const focus = followFocus(speakerOf(line, members), line?.id, manual);
	const look = (member: string | null) =>
		setManual({ lineId: line?.id, member });
	return (
		<div className="table-frame room-scene" data-focused="">
			<RoundTable
				members={members}
				groupRoom={roomKey}
				variant="full"
				focus={focus}
				onFocus={look}
				onSeat={look}
			/>
			<DialogueBox roomKey={roomKey} open streams={false} />
		</div>
	);
}
