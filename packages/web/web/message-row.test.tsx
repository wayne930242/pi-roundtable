import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG, type CharacterSpec } from "pi-roundtable/characters";
import { partial } from "pi-roundtable/testing";
import type { RoomMessage } from "../src/api-types.ts";
import { HostMessageRow } from "./components/host-message.tsx";
import { MessageRow, PendingRow } from "./components/message-row.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { store } from "./lib/app-store.ts";
import { loadKit } from "./lib/kit.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";

const KNIGHT: CharacterSpec = {
	v: 1,
	class: "knight",
	...CATALOG.classes.knight.preset,
};
const ROOM = "app:agent.guide";

let asked: string[] = [];
const realFetch = globalThis.fetch;
let page: TestPage;
beforeAll(async () => {
	await loadKit();
	page = await openPage();
	setConnection(partial<AppConnection>({ retry: () => undefined }));
	globalThis.fetch = (async (url: string | URL | Request) => {
		asked.push(String(url));
		return Response.json({ error: "none" }, { status: 404 });
	}) as typeof fetch;
});
afterEach(async () => {
	await page.render(null);
	asked = [];
});
afterAll(async () => {
	globalThis.fetch = realFetch;
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});

const settle = (ms = 80) =>
	page.act(() => new Promise<void>((done) => setTimeout(done, ms)));

const signIn = (id: string, character?: CharacterSpec) =>
	store.dispatch({
		type: "ready",
		protocol: 1,
		principal: id,
		name: "Wei Hung",
		...(character ? { character } : {}),
		uploads: { perMessage: 4, maxBytes: 1000 },
	} as never);

const mine = (id: number, over: Partial<RoomMessage> = {}): RoomMessage => ({
	id,
	room: ROOM,
	kind: "owner",
	principalId: "me",
	author: "Wei Hung",
	text: `message ${id}`,
	files: [],
	at: `2026-11-11T10:0${id}:00.000Z`,
	...over,
});

const Row = (props: { message: RoomMessage; header: boolean }) => (
	<MessageRow
		message={props.message}
		character={undefined}
		header={props.header}
		enter={false}
		timeZone="UTC"
		quotable={false}
	/>
);

const row = (id: number) =>
	page.container.querySelector<HTMLElement>(`li.message[data-mid="${id}"]`);
const knightIn = (element: Element | null | undefined) =>
	element?.querySelector(".message-avatar .av-host[data-badge] svg") != null;

test("the first of a group of one's own messages carries the knight; the rest keep an empty slot of its width", async () => {
	signIn("me", KNIGHT);
	await page.render(
		<ul>
			<Row message={mine(1)} header />
			<Row message={mine(2)} header={false} />
		</ul>,
	);
	await settle();
	const first = row(1);
	expect(first?.getAttribute("data-mine")).toBe("true");
	expect(knightIn(first)).toBe(true);
	// The picture comes first in the row; the stylesheet lays an own row out from the right.
	expect(first?.firstElementChild?.className).toBe("message-avatar");
	const second = row(2);
	expect(second?.getAttribute("data-mine")).toBe("true");
	expect(second?.querySelector(".message-avatar")?.childElementCount).toBe(0);
	// The viewer's knight is the store's: nothing was fetched for it.
	expect(asked).toEqual([]);
});

test("an own row is laid out from the right, so its picture stands at the right edge", () => {
	const css = readFileSync(join(import.meta.dir, "app.css"), "utf8");
	const rule = /\.message\[data-mine\] \{([^}]*)\}/.exec(css)?.[1] ?? "";
	expect(rule).toContain("flex-direction: row-reverse");
	// Reversed, the row already starts at the right: pushing it to the end would send it left.
	expect(rule).not.toContain("justify-content");
});

test("without a knight an own header row shows the account picture, then initials", async () => {
	signIn("me");
	await page.render(
		<ul>
			<Row message={mine(1)} header />
		</ul>,
	);
	await settle();
	const avatar = row(1)?.querySelector(".message-avatar");
	expect(avatar?.querySelector("img")?.getAttribute("src")).toBe(
		"api/people/me/picture",
	);
	await page.act(() => {
		avatar?.querySelector("img")?.dispatchEvent(new Event("error"));
	});
	expect(avatar?.textContent).toBe("WH");
	expect(asked).toEqual([]);
});

test("an old own message stored without its author is drawn with the viewer's knight", async () => {
	signIn("me", KNIGHT);
	const { principalId: _dropped, ...old } = mine(1);
	await page.render(
		<ul>
			<Row message={old} header />
		</ul>,
	);
	await settle();
	expect(row(1)?.getAttribute("data-mine")).toBe("true");
	expect(knightIn(row(1))).toBe(true);
	expect(asked).toEqual([]);
});

test("a message not taken yet carries the knight too", async () => {
	signIn("me", KNIGHT);
	await page.render(
		<ul>
			<PendingRow
				pending={{ id: "p1", room: ROOM, text: "on its way", files: [] }}
			/>
		</ul>,
	);
	await settle();
	const pending = page.container.querySelector("li.message[data-pending]");
	expect(pending?.getAttribute("data-mine")).toBe("true");
	expect(knightIn(pending)).toBe(true);
});

test("one's own note and one's own message in a host room carry the knight as well", async () => {
	signIn("me", KNIGHT);
	await page.render(
		<ul>
			<Row message={mine(1, { note: true })} header />
			<HostMessageRow
				message={mine(2, {
					room: "app:host.inbox.c1",
					kind: "system",
					authorKind: "member",
					picture: { principal: "me" },
				})}
				header
				enter={false}
				timeZone="UTC"
				me="me"
				highlighted={false}
			/>
			<HostMessageRow
				message={mine(3, {
					room: "app:host.inbox.c1",
					kind: "system",
					authorKind: "member",
					picture: { principal: "me" },
				})}
				header={false}
				enter={false}
				timeZone="UTC"
				me="me"
				highlighted={false}
			/>
		</ul>,
	);
	await settle(160);
	const note = page.container.querySelector("li[data-note]");
	expect(note?.hasAttribute("data-mine")).toBe(true);
	expect(knightIn(note)).toBe(true);
	expect(row(2)?.getAttribute("data-mine")).toBe("true");
	expect(knightIn(row(2))).toBe(true);
	expect(row(3)?.querySelector(".message-avatar")?.childElementCount).toBe(0);
	expect(asked).toEqual([]);
});
