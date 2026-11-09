import { expect, spyOn, test } from "bun:test";
import {
	all,
	BUILD,
	choose,
	dialog,
	F1,
	F2,
	foldersPage,
	headings,
	List,
	labels,
	load,
	page,
	q,
	rightClick,
	rowOf,
	SCOUT,
	settle,
	show,
	TEAM,
	typeInto,
	WORK,
} from "./folders-fixture.tsx";
import { closeMenu } from "./lib/action-menu.ts";
import { store } from "./lib/app-store.ts";
import { layoutApi } from "./lib/layout-api.ts";

foldersPage();

test("the folder menu renames, mutes, steps and deletes; the ends have no step", async () => {
	load({
		folders: [WORK, { id: F2, name: "Play", rooms: [BUILD] }],
	});
	await show(<List />);
	await rightClick(q(`[data-folder="${F1}"] .folder-head`));
	expect(labels()).toEqual([
		"Rename",
		"Mute the whole folder",
		"Move down",
		"Delete folder",
	]);
	await page.act(() => closeMenu());
	await rightClick(q(`[data-folder="${F2}"] .folder-head`));
	expect(labels()).toEqual([
		"Rename",
		"Mute the whole folder",
		"Move up",
		"Delete folder",
	]);
});

test("muting a whole folder asks the server once and shows the bells at once; unmuting reverses it", async () => {
	load({ folders: [{ id: F1, name: "Work", rooms: [SCOUT, TEAM] }] });
	const mute = spyOn(layoutApi, "muteFolder").mockResolvedValue({
		muted: true,
		rooms: [SCOUT, TEAM],
	});
	try {
		await show(<List />);
		await rightClick(q(".folder-head"));
		await choose("Mute the whole folder");
		expect(mute).toHaveBeenCalledWith(F1, true);
		expect(store.getState().rooms[SCOUT]?.view?.muted).toBe(true);
		expect(store.getState().rooms[TEAM]?.view?.muted).toBe(true);
		mute.mockResolvedValue({ muted: false, rooms: [SCOUT, TEAM] });
		await rightClick(q(".folder-head"));
		expect(labels()).toContain("Unmute the whole folder");
		await choose("Unmute the whole folder");
		expect(mute).toHaveBeenLastCalledWith(F1, false);
		expect(store.getState().rooms[SCOUT]?.view?.muted).toBeUndefined();
	} finally {
		mute.mockRestore();
	}
});

test("deleting a folder asks first, with the words of the spec, and then deletes it", async () => {
	load({ folders: [WORK] });
	const remove = spyOn(layoutApi, "deleteFolder").mockResolvedValue({
		pins: [],
		folders: [],
	});
	try {
		await show(<List />);
		await rightClick(q(".folder-head"));
		await choose("Delete folder");
		expect(remove).not.toHaveBeenCalled();
		const ask = dialog("Delete folder");
		expect(ask?.textContent).toContain(
			"Delete the folder Work? Its rooms move to Ungrouped; no room is deleted.",
		);
		const confirm = [...(ask?.querySelectorAll("button") ?? [])].find(
			(one) => one.textContent === "Delete folder",
		);
		await page.click(confirm ?? null);
		expect(remove).toHaveBeenCalledWith(F1);
		expect(store.getState().folders).toEqual([]);
	} finally {
		remove.mockRestore();
	}
});

test("renaming shows the folder's name, refuses an empty one before asking the server, and sends the new one", async () => {
	load({ folders: [WORK] });
	const change = spyOn(layoutApi, "changeFolder").mockResolvedValue({
		pins: [],
		folders: [{ ...WORK, name: "Office" }],
	});
	try {
		await show(<List />);
		await rightClick(q(".folder-head"));
		await choose("Rename");
		const form = dialog("Rename folder");
		const input = form?.querySelector<HTMLInputElement>("input") ?? null;
		expect(input?.value).toBe("Work");
		await typeInto(input, "   ");
		await page.click(
			[...(form?.querySelectorAll("button") ?? [])].find(
				(one) => one.textContent === "Rename",
			) ?? null,
		);
		expect(change).not.toHaveBeenCalled();
		expect(form?.textContent).toContain(
			"Give the folder a name of 1 to 40 characters.",
		);
		await typeInto(input, "Office");
		await page.click(
			[...(form?.querySelectorAll("button") ?? [])].find(
				(one) => one.textContent === "Rename",
			) ?? null,
		);
		expect(change).toHaveBeenCalledWith(F1, { name: "Office" });
		expect(store.getState().folders[0]?.name).toBe("Office");
	} finally {
		change.mockRestore();
	}
});

test("the page's menu adds a folder outside arrange mode, and shows the server's refusal inside the dialog", async () => {
	const create = spyOn(layoutApi, "createFolder").mockRejectedValue(
		new Error("A folder of that name exists."),
	);
	try {
		await show(<List />);
		await page.click(q('[aria-label="Folders and order"]'));
		await settle(40);
		await choose("Add a folder");
		const form = dialog("Add a folder");
		await typeInto(
			form?.querySelector<HTMLInputElement>("input") ?? null,
			"Play",
		);
		await page.click(
			[...(form?.querySelectorAll("button") ?? [])].find(
				(one) => one.textContent === "Create",
			) ?? null,
		);
		expect(create).toHaveBeenCalledWith("Play");
		expect(form?.textContent).toContain("A folder of that name exists.");
		create.mockResolvedValue({
			pins: [],
			folders: [{ id: F2, name: "Play", rooms: [] }],
		});
		await page.click(
			[...(form?.querySelectorAll("button") ?? [])].find(
				(one) => one.textContent === "Create",
			) ?? null,
		);
		expect(store.getState().folders.map((f) => f.name)).toEqual(["Play"]);
		expect(headings()).toContain("Play");
	} finally {
		create.mockRestore();
	}
});

test("arrange mode shows a menu button on each row and a bar to add a folder; Done takes them away", async () => {
	await show(<List />);
	await page.click(q('[aria-label="Folders and order"]'));
	await settle(40);
	await choose("Arrange");
	expect(all(".row-more").length).toBe(4);
	// Each arranged row is marked, so its stylesheet keeps the button's strip clear of the chevron and time.
	expect(all(".room-list > li[data-arranging]").length).toBe(4);
	expect(q(".arrange-bar")?.textContent).toContain("Add a folder");
	await page.click(
		all("button").find((one) => one.textContent === "Done") ?? null,
	);
	expect(all(".row-more")).toEqual([]);
	expect(q(".arrange-bar")).toBeNull();
});

test("a row's menu pins and unpins it, and the list follows the server's answer", async () => {
	const pin = spyOn(layoutApi, "pinRoom").mockResolvedValue({
		pins: [SCOUT],
		folders: [],
	});
	try {
		await show(<List />);
		await rightClick(rowOf("scout"));
		expect(labels().slice(0, 2)).toEqual(["Pin", "Move to folder…"]);
		await choose("Pin");
		expect(pin).toHaveBeenCalledWith(SCOUT, true, null);
		expect(headings()).toEqual(["Home", "Pinned", "Knights", "Groups"]);
		pin.mockResolvedValue({ pins: [], folders: [] });
		await rightClick(rowOf("scout"));
		expect(labels().slice(0, 2)).toEqual(["Unpin", "Move to folder…"]);
		await choose("Unpin");
		expect(pin).toHaveBeenLastCalledWith(SCOUT, false, null);
		expect(headings()).toEqual(["Home", "Knights", "Groups"]);
	} finally {
		pin.mockRestore();
	}
});

test("Home has no pin and no folder in its menu; a pinned room can step up and down", async () => {
	load({ pins: [SCOUT, BUILD, TEAM] });
	await show(<List />);
	await rightClick(rowOf("guide"));
	expect(labels()).not.toContain("Pin");
	expect(labels()).not.toContain("Move to folder…");
	await page.act(() => closeMenu());
	await rightClick(rowOf("scout"));
	expect(labels().slice(0, 3)).toEqual([
		"Unpin",
		"Move to folder…",
		"Move down",
	]);
	await page.act(() => closeMenu());
	await rightClick(rowOf("build"));
	expect(labels().slice(0, 4)).toEqual([
		"Unpin",
		"Move to folder…",
		"Move up",
		"Move down",
	]);
	await page.act(() => closeMenu());
	const place = spyOn(layoutApi, "pinRoom").mockResolvedValue({
		pins: [BUILD, SCOUT, TEAM],
		folders: [],
	});
	try {
		await rightClick(rowOf("build"));
		await choose("Move up");
		expect(place).toHaveBeenCalledWith(BUILD, true, SCOUT);
		expect(all(".room-row strong").map((one) => one.textContent)).toEqual([
			"guide",
			"build",
			"scout",
			"team",
		]);
	} finally {
		place.mockRestore();
	}
});

test("Move to folder lists the folders and Ungrouped, marks where the room is, and moves it", async () => {
	load({ folders: [WORK, { id: F2, name: "Play", rooms: [] }] });
	const place = spyOn(layoutApi, "placeRoom").mockResolvedValue({
		pins: [],
		folders: [
			{ ...WORK, rooms: [] },
			{ id: F2, name: "Play", rooms: [SCOUT] },
		],
	});
	try {
		await show(<List />);
		await rightClick(rowOf("scout"));
		await choose("Move to folder…");
		const sheet = dialog("Move to folder…");
		const radios = [
			...(sheet?.querySelectorAll<HTMLInputElement>("input[type=radio]") ?? []),
		];
		expect(radios.map((one) => one.closest("label")?.textContent)).toEqual([
			"Ungrouped",
			"Work",
			"Play",
		]);
		expect(radios.map((one) => one.checked)).toEqual([false, true, false]);
		await page.click(radios[2] ?? null);
		await settle(40);
		expect(place).toHaveBeenCalledWith(SCOUT, F2, null);
		expect(store.getState().folders[1]?.rooms).toEqual([SCOUT]);
	} finally {
		place.mockRestore();
	}
});

test("Move to folder can add a folder first and then moves the room into it", async () => {
	const create = spyOn(layoutApi, "createFolder").mockResolvedValue({
		pins: [],
		folders: [{ id: F2, name: "Play", rooms: [] }],
	});
	const place = spyOn(layoutApi, "placeRoom").mockResolvedValue({
		pins: [],
		folders: [{ id: F2, name: "Play", rooms: [BUILD] }],
	});
	try {
		await show(<List />);
		await rightClick(rowOf("build"));
		await choose("Move to folder…");
		await page.click(
			all("button").find((one) => one.textContent === "New folder…") ?? null,
		);
		await settle(40);
		const form = dialog("Add a folder");
		await typeInto(
			form?.querySelector<HTMLInputElement>("input") ?? null,
			"Play",
		);
		await page.click(
			[...(form?.querySelectorAll("button") ?? [])].find(
				(one) => one.textContent === "Create",
			) ?? null,
		);
		await settle(40);
		expect(create).toHaveBeenCalledWith("Play");
		expect(place).toHaveBeenCalledWith(BUILD, F2, null);
		expect(store.getState().folders[0]?.rooms).toEqual([BUILD]);
	} finally {
		create.mockRestore();
		place.mockRestore();
	}
});

test("a row can be lifted: it and its folder block carry what the drag looks for", async () => {
	load({ pins: [BUILD], folders: [WORK] });
	await show(<List />);
	const row = rowOf("scout")?.closest("li");
	expect(row?.getAttribute("data-drop-item")).toBe("");
	expect(row?.getAttribute("data-key")).toBe(SCOUT);
	expect(row?.closest("[data-drop-zone]")?.getAttribute("data-folder")).toBe(
		F1,
	);
	expect(
		rowOf("build")?.closest("[data-drop-zone]")?.getAttribute("data-drop-zone"),
	).toBe("pinned");
	expect(
		rowOf("team")?.closest("[data-drop-zone]")?.getAttribute("data-drop-zone"),
	).toBe("rest");
	// Home cannot be lifted or dropped on.
	expect(rowOf("guide")?.closest("li")?.hasAttribute("data-drop-item")).toBe(
		false,
	);
	expect(q("[data-folder-block]")?.getAttribute("data-key")).toBe(F1);
	expect(q("[data-drop-root]")).not.toBeNull();
});

test("the pinned list is a place to drop before it holds a room: hidden until a row is lifted, and gone once a room is pinned", async () => {
	load({ folders: [WORK] });
	await show(<List />);
	const strip = q('[data-drop-zone="pinned"]');
	expect(strip?.hasAttribute("data-empty")).toBe(true);
	expect(strip?.getAttribute("data-zone-id")).toBe("pinned");
	expect(strip?.querySelector("h2")?.textContent).toBe("Pinned");
	expect(strip?.querySelector(".room-row")).toBeNull();
	// The first pin fills it.
	load({ pins: [BUILD], folders: [WORK] });
	await show(<List />);
	expect(q('[data-drop-zone="pinned"]')?.hasAttribute("data-empty")).toBe(
		false,
	);
	expect(q('[data-drop-zone="pinned"] .room-row')).not.toBeNull();
});

// ── The room's own menu ────────────────────────────────────────────────────────────────────
