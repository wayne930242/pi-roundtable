import { useSelector } from "../lib/app-store.ts";
import { plural } from "../lib/messages.ts";
import { openCards } from "../lib/tab-count.ts";
import { Icon } from "./icons.tsx";

/** The cards waiting on the person, in the always-visible chrome; a press goes to them. Gone at zero. */
export function WaitingButton() {
	const count = useSelector(openCards);
	if (!count) return null;
	const label = plural(count, "{count} card waiting", "{count} cards waiting");
	return (
		<button
			type="button"
			className="waiting-button"
			aria-label={label}
			title={label}
			onClick={() => import("../lib/waiting.ts").then((m) => m.openWaiting())}
		>
			<Icon name="shield" size={16} />
			{count}
		</button>
	);
}
