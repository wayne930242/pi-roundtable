import { expect, spyOn, test } from "bun:test";
import {
	choose,
	foldersPage,
	HOME,
	List,
	labels,
	load,
	page,
	rightClick,
	rowOf,
	SCOUT,
	show,
	until,
} from "./folders-fixture.tsx";
import { closeMenu } from "./lib/action-menu.ts";
import { store } from "./lib/app-store.ts";
import { setHomeMode } from "./lib/home-mode.ts";
import { layoutApi } from "./lib/layout-api.ts";

foldersPage();

test("on the chat list a room's menu offers Hide, and Unhide once it is hidden; Home has neither", async () => {
	setHomeMode("chats");
	const hide = spyOn(layoutApi, "hideRoom").mockResolvedValue({
		pins: [],
		hidden: [SCOUT],
		folders: [],
	});
	try {
		load({ pins: [SCOUT] });
		await show(<List />);
		await until(() => rowOf("scout") !== null);
		await rightClick(rowOf("scout"));
		expect(labels()).toContain("Hide");
		await choose("Hide");
		expect(hide).toHaveBeenCalledWith(SCOUT, true);
		expect(store.getState().hidden).toEqual([SCOUT]);
		// The room is out of the list but its menu stays reachable from elsewhere: here it says Unhide.
		store.dispatch({
			type: "layout_loaded",
			pins: [],
			hidden: [SCOUT],
			folders: [],
		});
		const { roomMenuOf } = await import("./lib/menus.ts");
		const spec = await roomMenuOf(SCOUT);
		expect(spec?.items.map((item) => item.label)).toContain("Unhide");
		expect(spec?.items.map((item) => item.label)).not.toContain("Hide");
		const home = await roomMenuOf(HOME);
		expect(home?.items.map((item) => item.label)).not.toContain("Hide");
	} finally {
		hide.mockRestore();
		setHomeMode("rooms");
		store.dispatch({
			type: "layout_loaded",
			pins: [],
			hidden: [],
			folders: [],
		});
		await page.act(() => closeMenu());
	}
});

test("on the arranged room list a room's menu has no Hide", async () => {
	setHomeMode("rooms");
	load({ pins: [SCOUT] });
	await show(<List />);
	await until(() => rowOf("scout") !== null);
	await rightClick(rowOf("scout"));
	expect(labels()).not.toContain("Hide");
});
