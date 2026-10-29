import { useSelector } from "../lib/app-store.ts";
import { translate as t } from "../lib/messages.ts";
import { openRoomsMenu } from "../lib/rooms-menu.ts";
import { Icon } from "./icons.tsx";

/** The room list's menu button: a new folder, and arrange mode. It waits until the list is known. */
export default function RoomsMenuButton() {
	const listed = useSelector((state) => state.listed);
	if (!listed) return null;
	return (
		<button
			type="button"
			className="header-button icon-button"
			aria-haspopup="menu"
			aria-label={t("Folders and order")}
			onClick={(event) => openRoomsMenu(event.currentTarget)}
		>
			<Icon name="more" size={18} />
		</button>
	);
}
