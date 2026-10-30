import "../lib/layout-icons.ts";
import { type ReactNode, useId } from "react";
import { openMenu } from "../lib/action-menu.ts";
import { expandFolder, toggleCollapsed, useCollapsed } from "../lib/folds.ts";
import { plural, translate as t } from "../lib/messages.ts";
import type { Lifting } from "../lib/row-press.ts";
import { useRowPress } from "../lib/row-press.ts";
import type { MuteState } from "../lib/sections.ts";
import { Icon } from "./icons.tsx";

const actions = () => import("../lib/layout-actions.ts");

/** A folder's header menu; its code is the placement menus', loaded with the first menu. */
const folderMenuOf = (id: string) =>
	import("../lib/placement-items.ts").then((one) => one.folderMenu(id));

/** What a lifted folder block does: it moves among the folders, and opens a folded one the finger rests on. */
const folderLifting = (id: string): Lifting => ({
	mode: "folder",
	key: id,
	item: (source) => source.closest<HTMLElement>("[data-folder-block]"),
	root: (source) =>
		source.closest<HTMLElement>("[data-folder-block]")?.parentElement ?? null,
	onDrop: (outcome) => {
		if (outcome.type === "folder")
			void actions().then((one) => one.placeFolderBefore(id, outcome.before));
	},
	open: expandFolder,
});

/**
 * A folder of the room list: a light section header with the name, how many rooms, a fold button and
 * a menu, and under it the rooms. A folded folder shows a stack of the pictures of its rooms (`stack`)
 * and what in it needs the owner (`summary`), so a card waiting there does not hide behind the fold. The folder that holds the open room shows open,
 * without changing the fold kept for this device. Long-pressing or dragging the header moves the folder.
 */
export function FolderBlock(props: {
	id: string;
	name: string;
	count: number;
	/** The room open beside the list or in the drawer: its folder shows open. */
	holdsActive: boolean;
	muted: MuteState;
	/** What waits or works inside, shown while folded. */
	summary: ReactNode;
	/** The pictures of the rooms inside, stacked, shown while folded. */
	stack: ReactNode;
	children: ReactNode;
}) {
	const { id, name } = props;
	const folded = useCollapsed().has(id);
	const open = props.holdsActive || !folded;
	const bodyId = useId();
	const press = useRowPress(() => folderMenuOf(id), folderLifting(id));
	const openMenuFrom = (button: HTMLElement) => {
		folderMenuOf(id).then(
			(spec) => {
				if (!spec) return;
				const box = button.getBoundingClientRect();
				openMenu({
					...spec,
					at: { x: box.left, y: box.bottom },
					via: "key",
					source: button,
				});
			},
			() => undefined,
		);
	};
	return (
		<section
			className="folder"
			aria-label={name}
			data-folder-block=""
			data-key={id}
			data-drop-zone="folder"
			data-zone-id={id}
			data-folder={id}
			data-collapsed={open ? undefined : ""}
		>
			<header className="folder-head" data-folder-head="" {...press}>
				<button
					type="button"
					className="folder-toggle"
					aria-expanded={open}
					aria-controls={bodyId}
					aria-label={
						open ? t("Collapse {name}", { name }) : t("Expand {name}", { name })
					}
					onClick={() => toggleCollapsed(id)}
				>
					<Icon
						name="chevron"
						size={16}
						className="folder-chevron"
						data-open={open || undefined}
					/>
					<strong>{name}</strong>
					<span className="meta">
						{plural(props.count, "{count} room", "{count} rooms")}
					</span>
					{open ? null : props.stack}
				</button>
				{props.muted === "none" ? null : (
					<Icon
						name="bell-off"
						size={14}
						className="muted-mark"
						data-partial={props.muted === "some" || undefined}
						role="img"
						aria-hidden={false}
						aria-label={
							props.muted === "all"
								? t("Notifications are off")
								: t("Some notifications are off")
						}
					/>
				)}
				{open ? null : props.summary}
				<button
					type="button"
					className="icon-button folder-more"
					aria-haspopup="menu"
					aria-label={t("Folder menu")}
					onClick={(event) => openMenuFrom(event.currentTarget)}
				>
					<Icon name="more" size={18} />
				</button>
			</header>
			<div id={bodyId} className="folder-body" hidden={!open}>
				{open ? (
					props.count === 0 ? (
						<p className="meta folder-empty">
							{t("No rooms in this folder yet.")}
						</p>
					) : (
						props.children
					)
				) : null}
			</div>
		</section>
	);
}
