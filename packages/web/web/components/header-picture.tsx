import { translate as t } from "../lib/messages.ts";

/** The room's picture in the header; where the room has a drawer, tapping it opens the drawer. */
export function HeaderPicture(props: {
	open: (() => void) | undefined;
	children: React.ReactNode;
}) {
	if (!props.open) return props.children;
	return (
		<button
			type="button"
			className="room-picture"
			aria-label={t("Switch rooms")}
			aria-haspopup="dialog"
			onClick={props.open}
		>
			{props.children}
		</button>
	);
}
