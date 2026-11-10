import { expect, test } from "bun:test";
import { F1, F2, Home, loadChats, NEWS, seed } from "./chats-fixture.tsx";
import {
	all,
	BUILD,
	foldersPage,
	page,
	q,
	SCOUT,
	until,
} from "./folders-fixture.tsx";

foldersPage();

const show = async (node: React.ReactNode) => {
	await page.render(node);
	await until(() => q(".chats") !== null && all(".chat-row, .pin").length > 0);
};
const names = (selector: string) => all(selector).map((one) => one.textContent);
const folders = [
	{ id: F1, name: "Work", rooms: [SCOUT] },
	{ id: F2, name: "Play", rooms: [NEWS] },
];

test("a folder chip is a plain button with its name and a count of unread messages, and no icon or tint", async () => {
	loadChats({ folders });
	seed(0, { [NEWS]: 12, [SCOUT]: 0 });
	await show(<Home />);
	await until(() => q(".chips") !== null);
	const chip = all(".chip")[2] as HTMLElement;
	expect(chip.querySelector("svg")).toBeNull();
	expect(chip.getAttribute("style")).toBeNull();
	expect(chip.querySelector(".chip-label")?.textContent).toBe("Play");
	expect(chip.querySelector(".chip-count")?.textContent).toBe("12");
	expect(all(".chip")[1]?.querySelector(".chip-count")).toBeNull();
	expect(all(".chip")[0]?.querySelector(".chip-count")).toBeNull();
});

test("in All each row wears its folder's tag; in a folder the rows do not, and the other folders' unread rooms lead under Other unread", async () => {
	loadChats({ folders });
	seed(0, { [NEWS]: 2 });
	await show(<Home />);
	await until(() => q(".chips") !== null);
	const tagged = all(".chat-row").map((row) => [
		row.querySelector("strong")?.textContent,
		row.querySelector(".folder-tag")?.textContent ?? null,
	]);
	expect(tagged).toContainEqual(["scout", "Work"]);
	expect(tagged).toContainEqual(["news", "Play"]);
	expect(tagged).toContainEqual(["build", null]);
	expect(q(".elsewhere")).toBeNull();
	await page.click(all(".chip")[1] ?? null);
	expect(names(".elsewhere .chat-row strong")).toEqual(["news"]);
	expect(q(".elsewhere .chat-row .folder-tag")?.textContent).toBe("Play");
	expect(q(".elsewhere h2")?.textContent).toBe("Other unread");
	// The active folder's own rooms sit under a heading of its name.
	expect(q(".folder-section h2")?.textContent).toBe("Work");
	expect(names(".chat-list:not(.elsewhere-list) .chat-row strong")).toEqual([
		"scout",
	]);
	expect(q(".chat-list:not(.elsewhere-list) .folder-tag")).toBeNull();
	// Once read, the room drops back to its own folder.
	seed(0, { [NEWS]: 0 });
	await until(() => q(".elsewhere") === null);
	await until(() => q(".folder-section h2") === null);
});

test("on a phone the pins sit in a dock above the bar, in pin order with their badges; a column keeps them on top", async () => {
	loadChats({ pins: [BUILD, SCOUT] });
	seed(0, { [BUILD]: 3 });
	await show(<Home />);
	expect(q(".pins:not(.pin-dock)")).toBeNull();
	expect(names(".pin-dock .pin-name")).toEqual(["build", "scout"]);
	expect(q(".pin-dock .pin-count")?.textContent).toBe("3");
	expect(q(".chats-foot .pin-dock")).not.toBeNull();
	await show(<Home column />);
	expect(q(".pin-dock")).toBeNull();
	expect(names(".pins .pin-name")).toEqual(["build", "scout"]);
});
