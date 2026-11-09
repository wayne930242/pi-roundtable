import { expect, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { RoomMessage } from "../src/api-types.ts";
import { QueuedEditHost } from "./components/queued-edit.tsx";
import { closeMenu } from "./lib/action-menu.ts";
import { store } from "./lib/app-store.ts";
import { loadBuiltInMessages, setPresentation } from "./lib/messages.ts";
import { clearQueuedEdit } from "./lib/queued-edit.ts";
import { startShortcuts } from "./lib/shortcuts.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import {
	choose,
	labels,
	Message,
	menusPage,
	page,
	q,
	rightClick,
	SCOUT,
	said,
	settle,
	TEAM,
	WORK,
} from "./menus-fixture.tsx";

menusPage();

const sentDuring = (
	delivery: NonNullable<RoomMessage["delivery"]>,
	over: Partial<RoomMessage> = {},
): RoomMessage => ({
	id: 21,
	room: SCOUT,
	kind: "owner",
	principalId: "ada",
	author: "Ada",
	text: "one more thing",
	files: [],
	at: "2026-10-28T10:00:00.000Z",
	delivery,
	...over,
});

const signedInAsAda = () =>
	store.dispatch({
		type: "ready",
		protocol: 1,
		principal: "ada",
		name: "Ada",
		uploads: { perMessage: 4, maxBytes: 1000 },
	} as never);

/** Replaces the page's connection with one that keeps what it is told to send. */
function listening(): object[] {
	const sent: object[] = [];
	setConnection(
		partial<AppConnection>({
			send: (frame: object) => {
				sent.push(frame);
				return true;
			},
		}),
	);
	return sent;
}

test("a message sent during a turn says where it stands: added to the turn, queued, or cancelled", async () => {
	for (const [delivery, line] of [
		["steered", "Added to this turn"],
		["queued", "Queued"],
		["cancelled", "Cancelled"],
	] as const) {
		await page.render(<Message message={sentDuring(delivery)} />);
		await page.act(async () => {
			await settle(120);
		});
		expect(q(".delivery-line")?.textContent).toBe(line);
		expect(q("li.message")?.getAttribute("data-delivery")).toBe(delivery);
	}
	await page.render(<Message message={sentDuring("queued")} />);
	await page.render(<Message message={said()} />);
	expect(q(".delivery-line")).toBeNull();
});

test("a queued message offers its author Edit and Cancel; Cancel sends the frame", async () => {
	signedInAsAda();
	const sent = listening();
	await page.render(<Message message={sentDuring("queued")} />);
	await settle(120);
	await rightClick(q("li.message"));
	expect(labels().slice(0, 3)).toEqual(["Edit", "Cancel", "Copy"]);
	await choose("Cancel");
	expect(sent).toEqual([{ type: "cancel_queued", room: SCOUT, message: 21 }]);
	setConnection(partial<AppConnection>({ send: () => true }));
});

test("Edit opens the text in a sheet and Save sends the new text", async () => {
	signedInAsAda();
	const sent = listening();
	await page.render(
		<>
			<Message message={sentDuring("queued")} />
			<QueuedEditHost />
		</>,
	);
	await settle(120);
	await rightClick(q("li.message"));
	await choose("Edit");
	const box = q<HTMLTextAreaElement>("textarea.queued-edit-text");
	expect(box?.value).toBe("one more thing");
	await page.act(() => {
		if (box) {
			Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set?.call(box, "one more thing, please");
			box.dispatchEvent(new Event("input", { bubbles: true }));
		}
	});
	const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(one) => one.textContent === "Save",
	);
	if (!save) throw new Error("no Save button");
	await page.click(save);
	await settle(40);
	expect(sent).toEqual([
		{
			type: "edit_queued",
			room: SCOUT,
			message: 21,
			text: "one more thing, please",
		},
	]);
	setConnection(partial<AppConnection>({ send: () => true }));
});

test("a steered, a cancelled, or another person's queued message offers neither Edit nor Cancel", async () => {
	signedInAsAda();
	for (const message of [
		sentDuring("steered"),
		sentDuring("cancelled"),
		sentDuring("queued", { principalId: "bob", author: "Bob" }),
	]) {
		await page.render(<Message message={message} />);
		await settle(120);
		await rightClick(q("li.message"));
		expect(labels()).not.toContain("Edit");
		expect(labels()).not.toContain("Cancel");
		await page.act(() => closeMenu());
	}
});

/** Puts messages in the store as the room's stored ones and opens the room. */
function holdMessages(room: string, ...messages: RoomMessage[]): void {
	store.dispatch({
		type: "history_loaded",
		room,
		messages: messages.map((message) => ({ ...message, room })),
		more: false,
		older: false,
	});
	window.location.hash = `#/room/${encodeURIComponent(room)}`;
}

const arrowUp = (target: Element, init: KeyboardEventInit = {}) => {
	const event = new KeyboardEvent("keydown", {
		key: "ArrowUp",
		bubbles: true,
		cancelable: true,
		...init,
	});
	target.dispatchEvent(event);
	return event;
};

const composerBox = () => q<HTMLTextAreaElement>(".composer textarea");

test("↑ in the empty message box edits the person's latest queued message", async () => {
	signedInAsAda();
	holdMessages(
		SCOUT,
		sentDuring("queued", { id: 21, text: "first" }),
		sentDuring("queued", { id: 22, text: "second" }),
		sentDuring("queued", { id: 23, text: "bob's", principalId: "bob" }),
		said({ id: 24 }),
	);
	const stop = startShortcuts();
	try {
		await page.render(
			<>
				<Message composer />
				<QueuedEditHost />
			</>,
		);
		const box = composerBox();
		if (!box) throw new Error("no message box");
		let event: KeyboardEvent | undefined;
		await page.act(() => {
			event = arrowUp(box);
		});
		expect(event?.defaultPrevented).toBe(true);
		await settle(40);
		expect(q<HTMLTextAreaElement>("textarea.queued-edit-text")?.value).toBe(
			"second",
		);
	} finally {
		stop();
		await page.act(() => clearQueuedEdit());
	}
});

test("↑ does nothing with text in the box, with a modifier, while an input method composes, or without a queued message of one's own", async () => {
	signedInAsAda();
	const stop = startShortcuts();
	try {
		holdMessages(
			TEAM,
			sentDuring("steered"),
			sentDuring("queued", { id: 22, principalId: "bob" }),
			sentDuring("cancelled", { id: 23 }),
		);
		await page.render(
			<>
				<Message composer />
				<QueuedEditHost />
			</>,
		);
		const box = composerBox();
		if (!box) throw new Error("no message box");
		expect(arrowUp(box).defaultPrevented).toBe(false);
		await settle(40);
		expect(q("textarea.queued-edit-text")).toBeNull();

		holdMessages(WORK, sentDuring("queued"));
		const idle = async (event: KeyboardEvent) => {
			expect(event.defaultPrevented).toBe(false);
			await settle(40);
			expect(q("textarea.queued-edit-text")).toBeNull();
		};
		await idle(arrowUp(box, { isComposing: true }));
		await idle(arrowUp(box, { keyCode: 229 }));
		await idle(arrowUp(box, { shiftKey: true }));
		await idle(arrowUp(box, { ctrlKey: true }));
		await idle(arrowUp(box, { repeat: true }));
		// Alt+↑ still goes to the room before this one.
		expect(arrowUp(box, { altKey: true }).defaultPrevented).toBe(true);
		await settle(40);
		expect(q("textarea.queued-edit-text")).toBeNull();

		// The same key in the same box does act when nothing above stands in its way.
		holdMessages(WORK, sentDuring("queued"));
		expect(arrowUp(box).defaultPrevented).toBe(true);
		await page.act(() => clearQueuedEdit());
		await page.act(() => {
			box.value = "typing";
			box.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await idle(arrowUp(box));
		await idle(arrowUp(document.body));
	} finally {
		stop();
		await page.act(() => clearQueuedEdit());
	}
});

test("the shortcut list names ↑ for editing a waiting message, in en and zh-TW", async () => {
	const { default: ShortcutHelp } = await import(
		"./components/shortcut-help.tsx"
	);
	await page.render(<ShortcutHelp open />);
	expect(document.querySelector(".shortcut-list")?.textContent).toContain(
		"Edit your latest message that is still waiting",
	);
	await loadBuiltInMessages("zh-TW");
	setPresentation({
		title: "Console",
		panes: [],
		timeZone: "UTC",
		locale: "zh-TW",
	});
	try {
		await page.render(<ShortcutHelp open />);
		expect(document.querySelector(".shortcut-list")?.textContent).toContain(
			"\u7de8\u8f2f\u4f60\u6700\u65b0\u4e00\u5247\u9084\u5728\u6392\u968a\u7684\u8a0a\u606f",
		);
	} finally {
		setPresentation({ title: "Console", panes: [], timeZone: "UTC" });
		await loadBuiltInMessages(undefined);
	}
});
