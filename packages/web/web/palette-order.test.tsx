import { expect, test } from "bun:test";
import { GUIDE, loadChats, NEWS, QUIET } from "./chats-fixture.tsx";
import { Palette } from "./components/palette.tsx";
import {
	all,
	BUILD,
	foldersPage,
	page,
	SCOUT,
	until,
	view,
} from "./folders-fixture.tsx";
import { setHomeMode } from "./lib/home-mode.ts";

foldersPage();

const labels = () => all(".palette-label").map((one) => one.textContent);
const open = async () => {
	await page.render(<Palette open onClose={() => undefined} pages={[]} />);
	await until(() => all(".palette-label").length > 0);
};

test("on the chat home the search lists Home, the pins, then the rooms by latest activity, and the hidden last", async () => {
	loadChats({ pins: [BUILD], hidden: [NEWS] }, [
		view(GUIDE, { home: true }),
		view(SCOUT),
		view(BUILD),
		view(NEWS),
		view(QUIET),
	]);
	await open();
	expect(labels()).toEqual(["guide", "build", "scout", "quiet", "news"]);
	expect(all(".palette-list .meta").pop()?.textContent).toBe("Hidden");
});

test("with the room list the search keeps the server's order", async () => {
	loadChats({ pins: [BUILD], hidden: [NEWS] }, [
		view(GUIDE, { home: true }),
		view(SCOUT),
		view(BUILD),
		view(NEWS),
	]);
	setHomeMode("rooms");
	await open();
	expect(labels()).toEqual(["guide", "scout", "build", "news"]);
});
