import type { RoomMessage } from "../../src/api-types.ts";
import { useSelector } from "../lib/app-store.ts";
import { installStyle } from "../lib/lazy-style.ts";
import { openArchived } from "../lib/message-sheets.ts";
import { translate as t } from "../lib/messages.ts";
import { Icon } from "./icons.tsx";

// A lazy chunk, with its styles, so the page's first load stays as it was before start-over lines.
const START_OVER_CSS = `
.line.start-over {
	flex-wrap: wrap;
	margin-top: var(--space-4);
}

.line.start-over .link-button {
	min-height: 1.75rem;
	font-size: inherit;
}

.start-over-empty {
	margin-top: var(--space-6);
	font-size: var(--text-sm);
}
`;

/**
 * Where the room's conversation started over: the line, a way to read the archived conversation
 * before it, and, while nothing has been said since, the room's empty state under it.
 */
export default function StartOverLine(props: {
	message: RoomMessage;
	enter: boolean;
}) {
	installStyle("start-over", START_OVER_CSS);
	const { message } = props;
	const alone = useSelector((state) => {
		const room = state.rooms[message.room];
		return (
			room?.messages.at(-1)?.id === message.id &&
			room.pending.length === 0 &&
			room.live.length === 0
		);
	});
	return (
		<>
			<li className="line start-over" data-enter={props.enter || undefined}>
				<Icon name="reset" size={14} />
				<span>{t("Conversation started over")}</span>
				<button
					type="button"
					className="link-button"
					onClick={() => openArchived(message.room, message.id)}
				>
					{t("View the archived conversation")}
				</button>
			</li>
			{alone ? (
				<li className="line start-over-empty">
					<span>{t("No messages yet. Say hello.")}</span>
				</li>
			) : null}
		</>
	);
}
