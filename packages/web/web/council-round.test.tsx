import { expect, test } from "bun:test";
import {
	all,
	councilPage,
	everyone,
	group,
	load,
	messages,
	page,
	q,
	said,
	setPhone,
	settle,
	show,
} from "./council-fixture.tsx";
import { store } from "./lib/app-store.ts";
import { COUNCIL_MODE_KEY, resetCouncilModes } from "./lib/council-mode.ts";

councilPage();

test("a member speaks while its words show in the box, and only then: thinking, speaking, idle", async () => {
	load([...everyone, group("crew", ["guide", "scout", "mason"])]);
	await show();
	const crewRoom = "app:group.crew";
	const scout = () =>
		q('g.seat[data-seat="scout"]')?.getAttribute("data-state");
	const until = async (check: () => boolean) => {
		for (let tries = 0; tries < 40 && !check(); tries += 1) await settle(50);
	};
	await page.act(() => {
		store.dispatch({ type: "focused", room: crewRoom });
		store.dispatch({
			type: "activity",
			room: crewRoom,
			typing: true,
			stoppable: true,
		});
		store.dispatch({
			type: "round",
			room: crewRoom,
			round: {
				id: 4,
				state: "running",
				current: "scout",
				next: [],
				spoken: [],
				replies: 0,
				limit: 8,
			},
		});
	});
	await until(() => scout() === "thinking");
	expect(scout()).toBe("thinking");
	expect(q(".t2d.dim")).toBeNull();
	// its words stream into the box: the light comes on
	await page.act(() => {
		store.dispatch({
			type: "progress",
			room: crewRoom,
			event: { type: "text", delta: "Three leads found." },
		});
	});
	await until(() => scout() === "speaking");
	expect(scout()).toBe("speaking");
	expect(q(".t2d.dim")).not.toBeNull();
	// the turn ends and the stored reply has shown whole: the light goes off
	await page.act(() => {
		store.dispatch({
			type: "message",
			room: crewRoom,
			message: {
				id: 9,
				room: crewRoom,
				kind: "agent",
				agent: "scout",
				author: "scout",
				text: "Three leads found.",
				files: [],
				at: "2026-10-31T10:00:00.000Z",
			},
		});
		store.dispatch({
			type: "activity",
			room: crewRoom,
			typing: false,
			stoppable: false,
		});
		store.dispatch({
			type: "round",
			room: crewRoom,
			round: {
				id: 4,
				state: "ended",
				ended: "done",
				next: [],
				spoken: ["scout"],
				replies: 1,
				limit: 8,
			},
		});
	});
	await until(() => scout() === "idle");
	expect(scout()).toBe("idle");
	expect(q(".t2d.dim")).toBeNull();
	await page.act(() => {
		store.dispatch({ type: "focused", room: undefined });
	});
});

// ── the composer and the display mode of the table page ──────────────────────────────────────

/** Types into the page's composer, with the focus in it as a person's typing puts it, and sends. */
async function sendFromBox(text: string): Promise<HTMLTextAreaElement> {
	const box = q<HTMLTextAreaElement>("textarea");
	if (!box) throw new Error("no composer");
	await page.act(() => {
		box.focus();
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set?.call(box, text);
		box.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await page.click(q("button.composer-send"));
	await settle(30);
	return box;
}

test("on a phone a message sent from the table closes the keyboard; on a wide screen the box keeps the focus for the next one", async () => {
	load([...everyone, group("crew", ["guide", "scout"])]);
	setPhone(true);
	await show();
	let box = await sendFromBox("hello council");
	expect(said).toContainEqual({
		room: "app:group.crew",
		text: "hello council",
	});
	expect(document.activeElement).not.toBe(box);
	setPhone(false);
	await page.render(null);
	await show();
	box = await sendFromBox("and again");
	expect(said.at(-1)?.text).toBe("and again");
	expect(document.activeElement).toBe(box);
});

test("the same send in chat mode closes a phone's keyboard too", async () => {
	load([...everyone, group("crew", ["guide", "scout"])]);
	setPhone(true);
	await show();
	await page.click(
		all<HTMLInputElement>('.table-mode input[type="radio"]').find(
			(radio) => radio.value === "chat",
		) ?? null,
	);
	await settle();
	const box = await sendFromBox("from the chat");
	expect(said.at(-1)).toEqual({
		room: "app:group.crew",
		text: "from the chat",
	});
	expect(document.activeElement).not.toBe(box);
});

test("the table page switches between the scene and a chat of the council, keeps the choice for the council, and the chat shows the messages and the cards", async () => {
	load([...everyone, group("crew", ["guide", "scout"])]);
	messages.mockResolvedValue({
		messages: [
			{
				id: 4,
				room: "app:group.crew",
				kind: "agent",
				agent: "scout",
				author: "scout",
				text: "Three leads found.",
				files: [],
				at: "2026-10-31T10:00:00.000Z",
			},
		],
		more: false,
		cards: [],
	});
	await show();
	const radios = () => all<HTMLInputElement>('.table-mode input[type="radio"]');
	const legend = q(".table-mode legend");
	expect(legend?.textContent).toBe("Show the council as");
	expect(radios().map((radio) => radio.closest("label")?.textContent)).toEqual([
		"Animation mode",
		"Chat mode",
	]);
	// The scene by default: the seats and the dialogue box, no chat.
	expect(radios()[0]?.checked).toBe(true);
	expect(all("g.seat").length).toBeGreaterThan(0);
	expect(q(".scene-box")).not.toBeNull();
	expect(q(".table-chat")).toBeNull();
	// A draft typed in the scene's box stays for the chat's.
	await page.act(() => {
		const box = q<HTMLTextAreaElement>(".scene-box textarea");
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set?.call(box, "half a thought");
		box?.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await page.click(radios()[1] ?? null);
	await settle();
	expect(radios()[1]?.checked).toBe(true);
	expect(radios()[1]?.closest("label")?.getAttribute("data-checked")).toBe(
		"true",
	);
	expect(q(".scene-box")).toBeNull();
	expect(all("g.seat")).toHaveLength(0);
	const chat = q(".table-chat");
	expect(chat?.textContent).toContain("Three leads found.");
	expect(chat?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
		"half a thought",
	);
	expect(localStorage.getItem(COUNCIL_MODE_KEY("app:group.crew"))).toBe("chat");
	// A card that waits shows in the chat as it does in a room.
	await page.act(() => {
		store.dispatch({
			type: "prompt",
			room: "app:group.crew",
			prompt: {
				id: "p9",
				kind: "approval",
				title: "Ship the release?",
				message: "Ship it.",
				purpose: "action",
			},
		});
	});
	await settle(30);
	expect(q(".table-chat")?.textContent).toContain("Ship the release?");
	// A page that comes back to the table finds the chat.
	resetCouncilModes();
	await page.render(null);
	await show();
	expect(q(".table-chat")).not.toBeNull();
	expect(q(".scene-box")).toBeNull();
	// And the card waits in the scene's box too.
	await page.click(radios()[0] ?? null);
	await settle();
	expect(q(".table-chat")).toBeNull();
	expect(q(".scene-box")?.textContent).toContain("Ship the release?");
	expect(localStorage.getItem(COUNCIL_MODE_KEY("app:group.crew"))).toBe(
		"scene",
	);
});

test("a table with no council has no mode switch", async () => {
	load(everyone);
	await show();
	expect(q(".table-mode")).toBeNull();
});
