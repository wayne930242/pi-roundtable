import { installHostStyle } from "../lib/host-style.ts";
import { plural } from "../lib/messages.ts";
import { useHost } from "../lib/host-state.ts";

installHostStyle();

/** How many messages of a room the person has not read; nothing when there are none. */
export default function UnreadMark({ room }: { room: string }) {
	const count = useHost((state) => state.unread[room] ?? 0);
	if (count <= 0) return null;
	return (
		<span
			className="unread-mark"
			role="img"
			aria-label={plural(count, "{count} unread message", "{count} unread messages")}
		>
			{count > 99 ? "99+" : count}
		</span>
	);
}
