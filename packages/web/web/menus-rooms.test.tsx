import { expect, spyOn, test } from "bun:test";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { RoomMenu } from "./components/room-menu.tsx";
import { RoomSwitcher, useSwitcher } from "./components/switcher.tsx";
import { closeMenu } from "./lib/action-menu.ts";
import { closeAgentSheet, currentAgentSheet } from "./lib/agent-sheet.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import {
	checked,
	choose,
	config,
	List,
	labels,
	menusPage,
	page,
	q,
	rightClick,
	rowOf,
	SCOUT,
	settle,
	TEAM,
} from "./menus-fixture.tsx";

menusPage();

test("an agent row's menu has the edit, look, notifications, mode and restart actions that work today", async () => {
	await page.render(<List />);
	await rightClick(rowOf("scout"));
	expect(labels()).toEqual([
		"Pin",
		"Move to folder…",
		"Edit knight",
		"Change look",
		"Skills",
		"Notifications",
		"Yolo mode",
		"Long-running mode",
		"Start over",
		"Archive knight",
	]);
	expect(q("[role=menu]")?.getAttribute("aria-label")).toBe("scout");
	expect(rowOf("scout")?.getAttribute("data-hold")).toBe("row");
});

test("a group row has the modes and restart but no agent edit; a thread row has no menu", async () => {
	await page.render(<List />);
	await rightClick(rowOf("team"));
	expect(labels()).toEqual([
		"Pin",
		"Move to folder…",
		"Edit group",
		"Notifications",
		"Yolo mode",
		"Long-running mode",
		"Start over",
		"Archive group",
	]);
	await page.act(() => closeMenu());
	await rightClick(q(".thread-card"), false);
	expect(labels()).toEqual([]);
});

test("Edit knight opens the knight sheet; Change look opens it at the character creator; Skills at the skills", async () => {
	await page.render(<List />);
	await rightClick(rowOf("scout"));
	await choose("Edit knight");
	expect(currentAgentSheet()).toMatchObject({ name: "scout", look: false });
	// The sheet is over the page, not a page of its own.
	expect(window.location.hash).toBe("#/rooms");

	closeAgentSheet();
	await rightClick(rowOf("scout"));
	await choose("Change look");
	expect(currentAgentSheet()).toMatchObject({ name: "scout", look: true });
	expect(window.location.hash).toBe("#/rooms");

	closeAgentSheet();
	await rightClick(rowOf("scout"));
	await choose("Skills");
	expect(currentAgentSheet()).toMatchObject({
		name: "scout",
		look: false,
		skills: true,
	});
	expect(window.location.hash).toBe("#/rooms");
});

test("the room menu's Skills closes the menu and opens the knight sheet at the skills; a group's menu has none", async () => {
	let closed = 0;
	const menu = (agent?: string) => (
		<ConfigContext.Provider value={config}>
			<RoomMenu
				open
				room={SCOUT}
				mode={{ yolo: false, longRunning: false }}
				agent={agent}
				onClose={() => {
					closed += 1;
				}}
				onAskYolo={() => undefined}
				onAskStartOver={() => undefined}
			/>
		</ConfigContext.Provider>
	);
	const skillsItem = () =>
		[...document.querySelectorAll<HTMLButtonElement>(".menu-link")].find(
			(one) => one.querySelector("strong")?.textContent === "Skills",
		) ?? null;
	await page.render(menu("scout"));
	await page.click(skillsItem());
	expect(closed).toBe(1);
	expect(currentAgentSheet()).toMatchObject({ name: "scout", skills: true });
	closeAgentSheet();
	await page.render(menu());
	expect(skillsItem()).toBeNull();
});

test("the notifications item shows whether the room is pushed and flips it through the server", async () => {
	const setMute = spyOn(api, "setMute").mockResolvedValue({ muted: true });
	try {
		await page.render(<List />);
		await rightClick(rowOf("scout"));
		expect(checked("Notifications")).toBe("true");
		await choose("Notifications");
		expect(setMute).toHaveBeenCalledWith(SCOUT, true);
		// The list shows the bell-slash as soon as the server has said so.
		expect(store.getState().rooms[SCOUT]?.view?.muted).toBe(true);
		expect(
			rowOf("scout")
				?.querySelector("svg[aria-label]")
				?.getAttribute("aria-label"),
		).toBe("Notifications are off");
		expect(document.body.textContent).toContain(
			"Notifications are off for scout",
		);

		setMute.mockResolvedValue({ muted: false });
		await rightClick(rowOf("scout"));
		expect(checked("Notifications")).toBe("false");
		await choose("Notifications");
		expect(setMute).toHaveBeenLastCalledWith(SCOUT, false);
		expect(store.getState().rooms[SCOUT]?.view?.muted).toBeUndefined();
		expect(rowOf("scout")?.querySelector("svg[aria-label]")).toBeNull();
	} finally {
		setMute.mockRestore();
	}
});

test("a mute the server refuses leaves the room as it was and says so", async () => {
	const setMute = spyOn(api, "setMute").mockRejectedValue(
		new Error("Only an owner may do this."),
	);
	try {
		await page.render(<List />);
		await rightClick(rowOf("scout"));
		await choose("Notifications");
		expect(store.getState().rooms[SCOUT]?.view?.muted).toBeUndefined();
		expect(document.body.textContent).toContain("Only an owner may do this.");
	} finally {
		setMute.mockRestore();
	}
});

test("the long-running item flips the mode through changeMode; yolo off does too", async () => {
	const setMode = spyOn(api, "setMode").mockResolvedValue(undefined as never);
	try {
		await page.render(<List />);
		await rightClick(rowOf("scout"));
		expect(checked("Long-running mode")).toBe("false");
		await choose("Long-running mode");
		expect(setMode).toHaveBeenCalledWith(SCOUT, { longRunning: true });

		store.dispatch({
			type: "mode",
			room: SCOUT,
			yolo: true,
			longRunning: false,
		});
		await rightClick(rowOf("scout"));
		expect(checked("Yolo mode")).toBe("true");
		await choose("Yolo mode");
		expect(setMode).toHaveBeenLastCalledWith(SCOUT, { yolo: false });
	} finally {
		setMode.mockRestore();
	}
});

test("turning yolo on asks first, with the same confirm as the room menu, and then sets it", async () => {
	const setMode = spyOn(api, "setMode").mockResolvedValue(undefined as never);
	try {
		await page.render(<List />);
		await rightClick(rowOf("scout"));
		await choose("Yolo mode");
		expect(setMode).not.toHaveBeenCalled();
		const dialog = [...document.querySelectorAll("dialog")].find(
			(one) =>
				one.open && one.getAttribute("aria-label") === "Turn on yolo mode?",
		);
		expect(dialog).toBeDefined();
		const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find(
			(one) => one.textContent === "Turn on yolo mode",
		);
		await page.click(confirm ?? null);
		expect(setMode).toHaveBeenCalledWith(SCOUT, { yolo: true });
	} finally {
		setMode.mockRestore();
	}
});

test("Start over asks with its confirm, and restarts the room when confirmed", async () => {
	const startOver = spyOn(api, "startRoomOver").mockResolvedValue(
		undefined as never,
	);
	try {
		await page.render(<List />);
		await rightClick(rowOf("scout"));
		await choose("Start over");
		expect(startOver).not.toHaveBeenCalled();
		const dialog = [...document.querySelectorAll("dialog")].find(
			(one) =>
				one.open && one.getAttribute("aria-label") === "Start over scout?",
		);
		expect(dialog).toBeDefined();
		const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find(
			(one) => one.textContent === "Start over",
		);
		await page.click(confirm ?? null);
		expect(startOver).toHaveBeenCalledWith(SCOUT);
	} finally {
		startOver.mockRestore();
	}
});

function DrawerRoom() {
	const switcher = useSwitcher(true);
	return (
		<>
			<button type="button" id="avatar" onClick={switcher.show}>
				avatar
			</button>
			<RoomSwitcher {...switcher.drawer} current={TEAM} />
		</>
	);
}

test("a row of the phone drawer opens the same menu as a sheet; an action that leaves the room closes the drawer first", async () => {
	window.innerWidth = 390;
	await page.render(
		<>
			<DrawerRoom />
			<ActionMenuHost />
		</>,
	);
	await page.click(q("#avatar"));
	expect(q(".switcher")?.getAttribute("data-state")).toBe("open");
	// The rows are a chunk of their own, drawn a moment after the drawer opens.
	const stop = Date.now() + 3000;
	while (!q(".switcher-row[href*='scout']") && Date.now() < stop)
		await page.act(async () => {
			await settle(20);
		});
	await rightClick(q(".switcher-row[href*='scout']"));
	expect(q("dialog.sheet")?.hasAttribute("open")).toBe(true);
	expect(labels()).toContain("Edit knight");
	await choose("Edit knight");
	await settle(300);
	expect(currentAgentSheet()).toMatchObject({ name: "scout", look: false });
	expect(q(".switcher")?.getAttribute("data-state")).toBe("closed");
});

// ── Messages ─────────────────────────────────────────────────────────────────────────────────
