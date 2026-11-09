import { expect, spyOn, test } from "bun:test";
import {
	archived,
	chatsConfig,
	GUIDE,
	loadChats,
	NEWS,
	QUIET,
	T1,
} from "./chats-fixture.tsx";
import { ActionMenuHost } from "./components/action-menu.tsx";
import {
	all,
	foldersPage,
	labels,
	page,
	q,
	SCOUT,
	until,
	view,
} from "./folders-fixture.tsx";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { setHomeMode } from "./lib/home-mode.ts";
import { seedUnread } from "./lib/host-state.ts";
import { layoutApi } from "./lib/layout-api.ts";
import { teamApi } from "./lib/team-api.ts";
import HiddenPage from "./pages/hidden.tsx";

foldersPage();

const Hidden = () => (
	<ConfigContext.Provider value={chatsConfig}>
		<HiddenPage />
		<ActionMenuHost />
	</ConfigContext.Provider>
);

test("the page lists the hidden rooms with Unhide, then the archive with Restore and its delete behind a menu", async () => {
	const archive = spyOn(teamApi, "archive").mockResolvedValue({
		entries: archived(2),
	});
	const unhide = spyOn(layoutApi, "hideRoom").mockResolvedValue({
		pins: [],
		hidden: [NEWS],
		folders: [],
	});
	loadChats({ hidden: [QUIET, NEWS] }, [
		view(GUIDE, { home: true }),
		view(SCOUT),
		view(NEWS),
		view(QUIET),
		view(T1, { kind: "thread", parent: "app:agent.gone", readOnly: true }),
	]);
	seedUnread({ [QUIET]: 3 });
	await page.render(<Hidden />);
	await until(
		() => all(".hidden-room").length === 2 && all(".menu-item").length === 2,
	);
	expect(all(".hidden-room strong").map((one) => one.textContent)).toEqual([
		"quiet",
		"news",
	]);
	expect(q(".hidden-room .chat-pill")?.textContent).toBe("3");
	// An orphan dispatch thread is listed here, not on the home.
	await until(() => q(".thread-card, .thread-group") !== null);
	expect(q(".thread-card, .thread-group")).not.toBeNull();
	// Unhide asks the layout API for the room.
	const button = all<HTMLButtonElement>(".hidden-room button.secondary")[0];
	await page.click(button ?? null);
	expect(unhide).toHaveBeenCalledWith(QUIET, false);
	// The archive: Restore is a button, Delete is behind the ⋯ menu.
	const rows = all(".menu-item");
	expect(rows[0]?.textContent).toContain("Restore");
	expect(rows[0]?.textContent).not.toContain("Delete");
	await page.click(rows[0]?.querySelector(".row-more") ?? null);
	await until(() => labels().length > 0);
	expect(labels()).toEqual(["Delete"]);
	archive.mockRestore();
	unhide.mockRestore();
	setHomeMode("rooms");
	store.dispatch({ type: "layout_loaded", pins: [], hidden: [], folders: [] });
});
