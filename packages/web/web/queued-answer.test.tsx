import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { ConfigView, RoomMessage } from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { Composer } from "./components/composer.tsx";
import { MessageRow } from "./components/message-row.tsx";
import { QueuedEditHost } from "./components/queued-edit.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu } from "./lib/action-menu.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { loadKit } from "./lib/kit.ts";
import { clearQueuedEdit } from "./lib/queued-edit.ts";
import { setRouting } from "./lib/router.ts";
import { startShortcuts } from "./lib/shortcuts.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";

// A queued message that carries the answer to a block can be cancelled but not edited.
const ROOM = "app:agent.scout";
const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

const queued = (id: number, text: string, over: Partial<RoomMessage> = {}) => ({
	id,
	room: ROOM,
	kind: "owner" as const,
	principalId: "ada",
	author: "Ada",
	text,
	files: [],
	at: "2026-11-08T10:00:00.000Z",
	delivery: "queued" as const,
	...over,
});

let page: TestPage;
beforeAll(async () => {
	await loadKit();
	page = await openPage();
	setRouting(undefined);
	setConnection(partial<AppConnection>({ send: () => true }));
	store.dispatch({
		type: "ready",
		protocol: 1,
		principal: "ada",
		name: "Ada",
		uploads: { perMessage: 4, maxBytes: 1000 },
	} as never);
});
afterAll(async () => {
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});
afterEach(async () => {
	await page.act(() => closeMenu());
	await page.act(() => clearQueuedEdit());
	await page.render(null);
});

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const q = <T extends Element = HTMLElement>(selector: string): T | null =>
	document.querySelector<T>(selector);
const labels = () =>
	[...document.querySelectorAll('[role^="menuitem"]')].map(
		(one) => one.textContent,
	);

const Row = (props: { message: RoomMessage; composer?: boolean }) => (
	<ConfigContext.Provider value={config}>
		<ul>
			<MessageRow
				message={props.message}
				character={undefined}
				header
				enter={false}
				timeZone="UTC"
				quotable
			/>
		</ul>
		{props.composer ? (
			<Composer
				draftKey={ROOM}
				name="scout"
				limits={undefined}
				stoppable={false}
				onSend={() => undefined}
				onStop={() => undefined}
			/>
		) : null}
		<QueuedEditHost />
		<ActionMenuHost />
		<Toaster />
	</ConfigContext.Provider>
);

test("a queued message that carries a block answer offers Cancel but not Edit, since its block would keep the old pick", async () => {
	await page.render(
		<Row message={queued(41, "User picked: b", { answer: true })} />,
	);
	await settle(120);
	await page.act(async () => {
		q("li.message")?.dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
		);
		await settle(600);
	});
	expect(labels()).not.toContain("Edit");
	expect(labels().slice(0, 2)).toEqual(["Cancel", "Copy"]);
});

test("↑ in the empty message box skips a queued answer, which cannot be edited", async () => {
	store.dispatch({
		type: "history_loaded",
		room: ROOM,
		messages: [
			queued(51, "typed"),
			queued(52, "User picked: b", { answer: true }),
		],
		more: false,
		older: false,
	});
	window.location.hash = `#/room/${encodeURIComponent(ROOM)}`;
	const stop = startShortcuts();
	try {
		await page.render(<Row message={queued(51, "typed")} composer />);
		const box = q<HTMLTextAreaElement>(".composer textarea");
		if (!box) throw new Error("no message box");
		await page.act(() => {
			box.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "ArrowUp",
					bubbles: true,
					cancelable: true,
				}),
			);
		});
		await settle(40);
		expect(q<HTMLTextAreaElement>("textarea.queued-edit-text")?.value).toBe(
			"typed",
		);
	} finally {
		stop();
	}
});

test("a refusal of an edit of an answer tells the person to cancel it instead", async () => {
	await page.render(<Row message={queued(61, "x")} />);
	await page.act(() =>
		store.dispatch({ type: "refused", code: "answer_locked" } as never),
	);
	await settle(40);
	expect(
		[...document.querySelectorAll(".toast")].map((one) => one.textContent),
	).toContainEqual(expect.stringContaining("Cancel it"));
	await page.act(() => store.dispatch({ type: "refusal_dismissed" }));
});
