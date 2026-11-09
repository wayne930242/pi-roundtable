import { memo } from "react";
import { useAccentStyle } from "../lib/characters.ts";
import { pinBadge } from "../lib/chats-home.ts";
import { useHost } from "../lib/host-state.ts";
import { useMenuPress } from "../lib/menu-press.ts";
import { roomMenuOf } from "../lib/menus.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import type { RowData } from "../pages/rooms.tsx";
import { Icon } from "./icons.tsx";
import { RoomPicture } from "./room-picture.tsx";

/**
 * A pinned room as a big figure with its name under it. The corner shows one thing: the cards
 * waiting there, else the unread messages, else a dot while its agent works; Home also wears a star.
 */
export const PinTile = memo(function PinTile(
	props: Omit<RowData, "key"> & { active: boolean; size: number },
) {
	const { view } = props;
	const press = useMenuPress(() => roomMenuOf(view.key));
	const accent = useAccentStyle(view.character);
	const unread = useHost((state) => state.unread[view.key] ?? 0);
	const badge = pinBadge(props.waiting, unread, props.typing);
	return (
		<li className="pin-item">
			<a
				className="pin"
				{...press}
				href={hrefFor("room", view.key)}
				data-room-pin={view.key}
				data-home={view.home || undefined}
				aria-current={props.active ? "page" : undefined}
				style={accent}
			>
				<span className="pin-picture">
					<RoomPicture view={view} size={props.size} bare />
					{badge && badge.kind !== "typing" ? (
						<span
							className="pin-count"
							data-kind={badge.kind}
							role="img"
							aria-label={
								badge.kind === "waiting"
									? plural(
											badge.count,
											"{count} card waiting",
											"{count} cards waiting",
										)
									: plural(
											badge.count,
											"{count} unread message",
											"{count} unread messages",
										)
							}
						>
							{badge.count > 99 ? "99+" : badge.count}
						</span>
					) : null}
					{view.home ? (
						<span className="pin-star" role="img" aria-label={t("Home")}>
							<Icon name="star" size={14} />
						</span>
					) : null}
					{badge?.kind === "typing" ? (
						<span
							className="pin-dot"
							data-home={view.home || undefined}
							role="img"
							aria-label={t("Working")}
						/>
					) : null}
				</span>
				<span className="pin-name">{view.displayName}</span>
			</a>
		</li>
	);
});
