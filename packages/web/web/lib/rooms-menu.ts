import "./layout-icons.ts";
import { openMenu } from "./action-menu.ts";
import { isArranging, setArranging } from "./arrange.ts";
import { bulkItems } from "./bulk-items.ts";
import { askFolderDialog } from "./folder-dialogs.ts";
import { translate as t } from "./messages.ts";

/** The room list's menu: mark everything read, clear every finished thread, a new folder, and arrange mode, which shows each row's menu button. */
export function openRoomsMenu(button: HTMLElement): void {
	const box = button.getBoundingClientRect();
	const arranging = isArranging();
	openMenu({
		title: t("Rooms"),
		items: [
			...bulkItems(),
			{
				id: "new-folder",
				label: t("Add a folder"),
				icon: "plus",
				run: () => askFolderDialog({ kind: "new" }),
			},
			{
				id: "arrange",
				label: arranging ? t("Done") : t("Arrange"),
				icon: arranging ? "check" : "list",
				run: () => setArranging(!arranging),
			},
		],
		at: { x: box.left, y: box.bottom },
		via: "key",
		source: button,
	});
}
