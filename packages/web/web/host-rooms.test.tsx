import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	HostCardView,
	ReadMarkView,
	RoomMessage,
	ServerFrame,
} from "../src/api-types.ts";
import { HostCard } from "./components/host-card.tsx";
import { HostForm } from "./components/host-form.tsx";
import { HostMarkdown } from "./components/host-markdown.tsx";
import { HostMessageRow } from "./components/host-message.tsx";
import { initialsOf } from "./components/host-picture.tsx";
import { PlainText } from "./components/plain-text.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { store } from "./lib/app-store.ts";
import { addressOf, splitRoomKey } from "./lib/host-api.ts";
import * as hostState from "./lib/host-state.ts";

const { onFrame } = hostState;

import { initialState, reduce } from "./lib/rooms.ts";
import { setRouting } from "./lib/router.ts";

type HostSnapshot = Parameters<typeof hostState.useHost>[0] extends (
	state: infer S,
) => unknown
	? S
	: never;

function Peek<T>(props: { pick(state: HostSnapshot): T; out(value: T): void }) {
	props.out(hostState.useHost(props.pick));
	return null;
}

/** What a component would read of the host state right now. */
function peek<T>(pick: (state: HostSnapshot) => T): T {
	let value: T | undefined;
	renderToStaticMarkup(<Peek pick={pick} out={(found) => (value = found)} />);
	return value as T;
}

const ROOM = "app:inbox.thread-aaaa0001";

const message = (id: number, over: Partial<RoomMessage> = {}): RoomMessage => ({
	id,
	room: ROOM,
	kind: "owner",
	author: "Dana",
	text: `message ${id}`,
	files: [],
	at: "2026-10-29T10:00:00.000Z",
	authorKind: "external",
	...over,
});

const row = (
	over: Partial<RoomMessage>,
	props: { me?: string; header?: boolean } = {},
) =>
	renderToStaticMarkup(
		<HostMessageRow
			message={message(1, over)}
			header={props.header ?? true}
			enter={false}
			timeZone="UTC"
			me={props.me}
			highlighted={false}
		/>,
	);

test("what an outside party wrote is plain text: markup and Markdown stay text, only a web address links", () => {
	const html = renderToStaticMarkup(
		<PlainText text="**bold** <b>x</b> [a](javascript:alert(1)) see https://example.com/a?b=1, and javascript:alert(2) or ftp://x.test/f" />,
	);
	expect(html).toContain("**bold**");
	expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
	expect(html).toContain('href="https://example.com/a?b=1"');
	// The comma after the address is the sentence's.
	expect(html).toContain("</a>, and");
	expect(html.match(/<a /g)).toHaveLength(1);
	expect(html).not.toContain('href="javascript');
	expect(html).not.toContain("ftp://x.test/f</a>");
	expect(html).toContain('rel="noreferrer noopener"');
});

test("the host's Markdown links web and same-origin addresses, shows only a saved file as a picture, and keeps raw HTML as text", () => {
	const html = renderToStaticMarkup(
		<HostMarkdown
			source={[
				"[web](https://example.com/x) [room](/console/room/app%3Ainbox.thread-aaaa0001?message=3) [bad](javascript:alert(1))",
				"![chart](file:f1-Abc_9) ![remote](https://evil.test/p.png) ![odd](file:../../x)",
				"<script>alert(1)</script>",
			].join("\n\n")}
		/>,
	);
	expect(html).toContain('href="https://example.com/x"');
	expect(html).toContain('target="_blank"');
	expect(html).toContain(
		'href="/console/room/app%3Ainbox.thread-aaaa0001?message=3"',
	);
	expect(html).not.toContain("javascript:");
	expect(html).toContain('src="api/files/f1-Abc_9"');
	expect(html).not.toContain("evil.test");
	expect(html).not.toContain("file:../");
	expect(html).toContain("remote");
	expect(html).toContain("&lt;script&gt;");
	expect(html).not.toContain("<script>");
});

test("each author kind is drawn as itself", () => {
	const external = row({
		text: "<i>hi</i> https://example.com",
		authorLabel: "Customer",
	});
	expect(external).toContain('data-author="external"');
	expect(external).toContain("&lt;i&gt;hi&lt;/i&gt;");
	expect(external).toContain("Customer");
	expect(external).not.toContain("data-mine");

	const assistant = row({
		authorKind: "assistant",
		kind: "agent",
		text: "**bold**",
	});
	expect(assistant).toContain('data-author="assistant"');
	expect(assistant).toContain("<strong>bold</strong>");

	const notice = row({
		authorKind: "notice",
		kind: "system",
		text: "Assigned to **Mel**",
	});
	expect(notice).toContain('class="host-notice"');
	expect(notice).toContain("<strong>Mel</strong>");

	// A member's own message stands at the right; another member's does not.
	const own = row(
		{ authorKind: "member", principalId: "p-ada" },
		{ me: "p-ada" },
	);
	expect(own).toContain('data-mine="true"');
	expect(
		row({ authorKind: "member", principalId: "p-mel" }, { me: "p-ada" }),
	).not.toContain("data-mine");
	expect(row({ edited: true })).toContain("edited");
	expect(row({ expiredFiles: 2 })).toContain("2 files were removed");
	expect(row({}, { header: false })).not.toContain("message-meta");
	expect(row({})).toContain('data-mid="1"');
});

const card = (over: Partial<HostCardView> = {}): HostCardView => ({
	id: "c1",
	room: ROOM,
	title: "Draft ready",
	body: "Hi **Dana**",
	at: "2026-10-29T10:00:00.000Z",
	updatedAt: "2026-10-29T10:00:00.000Z",
	buttons: [{ id: "send", label: "Send reply" }],
	links: [
		{ label: "Order", url: "https://example.com/o" },
		{ label: "Room", url: "/console/room/x" },
	],
	...over,
});
const run = async () => ({ ok: true as const });

test("a card has buttons only while it is open", () => {
	const html = (state?: HostCardView["state"]) =>
		renderToStaticMarkup(
			<HostCard card={card(state ? { state } : {})} run={run} />,
		);
	expect(html()).toContain("Send reply");
	expect(html("open")).toContain("Send reply");
	for (const state of ["working", "done", "superseded", "expired"] as const) {
		expect(html(state)).not.toContain("Send reply");
		expect(html(state)).toContain(`data-state="${state}"`);
	}
	expect(html()).toContain("<strong>Dana</strong>");
	// An outside link opens apart; a link on this origin does not.
	expect(html()).toContain('href="https://example.com/o" target="_blank"');
	expect(html()).toContain('href="/console/room/x"');
});

test("a room key splits into its kind and id, and an address names the room, the message or the page", () => {
	expect(splitRoomKey(ROOM)).toEqual({ kind: "inbox", id: "thread-aaaa0001" });
	expect(splitRoomKey("nonsense")).toBeUndefined();
	setRouting("/console");
	expect(addressOf({ room: ROOM, message: 7 })).toBe(
		`/console/room/${encodeURIComponent(ROOM)}?message=7`,
	);
	expect(addressOf({ page: "mailboxes", query: { q: "a b" } })).toBe(
		"/console/p/mailboxes?q=a+b",
	);
	setRouting(undefined);
	expect(addressOf({ room: ROOM })).toBe(`#/room/${encodeURIComponent(ROOM)}`);
	expect(addressOf({ page: "mailboxes" })).toBe("#/p/mailboxes");
});

test("a person's initials: a Latin name's first letters, a Chinese name's first character", () => {
	expect(initialsOf("Dana Wu")).toBe("DW");
	expect(initialsOf("mel")).toBe("M");
	expect(initialsOf("\u6797\u4f73\u73b2")).toBe("\u6797");
	expect(initialsOf("  ")).toBe("?");
});

test("the room store takes a host room's messages, edits and removals", () => {
	let state = initialState();
	const frame = (f: ServerFrame) => (state = reduce(state, f));
	frame({ type: "host_message", room: ROOM, message: message(1) });
	frame({ type: "host_message", room: ROOM, message: message(2) });
	frame({
		type: "host_edited",
		room: ROOM,
		message: message(2, { text: "fixed", edited: true }),
	});
	expect(state.rooms[ROOM]?.messages.map((one) => one.text)).toEqual([
		"message 1",
		"fixed",
	]);
	frame({ type: "host_removed", room: ROOM, id: 1 });
	expect(state.rooms[ROOM]?.messages.map((one) => one.id)).toEqual([2]);
});

// ── The read state, host cards and counters the lazy code keeps ────────────────────────────────────

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
	store.dispatch({
		type: "ready",
		protocol: 1,
		principal: "p-ada",
		name: "Ada",
		uploads: { perMessage: 4, maxBytes: 1000 },
	});
});

test("an arriving message counts as unread unless it is the person's own or the room is being read", () => {
	const room = "app:inbox.unread-room-0001";
	const counts = () => peek((state) => state.unread[room] ?? 0);
	expect(counts()).toBe(0);
	onFrame({ type: "host_message", room, message: message(10, { room }) });
	onFrame({
		type: "host_message",
		room,
		message: message(11, { room, principalId: "p-ada", authorKind: "member" }),
	});
	onFrame({
		type: "host_message",
		room,
		message: message(12, { room, kind: "system", authorKind: "notice" }),
	});
	expect(counts()).toBe(1);
	// The room open on screen and in view reads what arrives.
	store.dispatch({ type: "focused", room });
	Object.defineProperty(document, "visibilityState", {
		value: "visible",
		configurable: true,
	});
	onFrame({ type: "host_message", room, message: message(13, { room }) });
	expect(counts()).toBe(1);
	store.dispatch({ type: "focused", room: undefined });
	// The person's own read from another device clears what it covers.
	store.dispatch({
		type: "host_message",
		room,
		message: message(10, { room }),
	});
	store.dispatch({
		type: "host_message",
		room,
		message: message(14, { room }),
	});
	onFrame({
		type: "read",
		room,
		principal: "p-ada",
		name: "Ada",
		upTo: 10,
		at: "2026-10-29T10:05:00.000Z",
	});
	expect(counts()).toBe(1);
	onFrame({
		type: "read",
		room,
		principal: "p-ada",
		name: "Ada",
		upTo: 99,
		at: "2026-10-29T10:06:00.000Z",
	});
	expect(counts()).toBe(0);
});

test("another person's read moves their mark forward and never back", () => {
	const room = "app:inbox.reads-room-00001";
	const read = (
		principal: string,
		name: string,
		upTo: number,
		second: number,
	) =>
		onFrame({
			type: "read",
			room,
			principal,
			name,
			upTo,
			at: `2026-10-29T10:00:0${second}.000Z`,
		});
	read("p-mel", "Mel", 5, 0);
	read("p-kim", "Kim", 4, 1);
	read("p-mel", "Mel", 3, 2);
	read("p-mel", "Mel", 8, 3);
	const marks: readonly ReadMarkView[] = peek(
		(state) => state.reads[room] ?? hostState.noReads,
	);
	expect(marks.map((mark) => [mark.name, mark.upTo]).sort()).toEqual([
		["Kim", 4],
		["Mel", 8],
	]);
});

test("a host card arrives, is replaced by id, and a change of the room, the list or a page is counted", () => {
	const room = "app:inbox.cards-room-00001";
	const at = (minute: number) => `2026-10-29T10:0${minute}:00.000Z`;
	onFrame({
		type: "host_card",
		room,
		card: card({ id: "b", room, at: at(2) }),
	});
	onFrame({
		type: "host_card",
		room,
		card: card({ id: "a", room, at: at(1) }),
	});
	onFrame({
		type: "host_card",
		room,
		card: card({ id: "a", room, at: at(1), state: "done" }),
	});
	expect(
		peek((state) => state.cards[room])?.map((one) => [one.id, one.state]),
	).toEqual([
		["a", "done"],
		["b", undefined],
	]);
	onFrame({ type: "room_changed", room });
	onFrame({ type: "room_changed", room });
	onFrame({ type: "list_changed", kind: "inbox" });
	onFrame({ type: "page_changed", page: "mailboxes" });
	expect(peek((state) => state.rooms[room])).toBe(2);
	expect(peek((state) => state.lists.inbox)).toBeGreaterThanOrEqual(1);
	expect(peek((state) => state.pages.mailboxes)).toBeGreaterThanOrEqual(1);
});

// ── A form ────────────────────────────────────────────────────────────────────────────────────────

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
	setRouting(undefined);
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});
afterEach(async () => {
	await page.render(null);
});

const typeInto = (element: Element | null, text: string) =>
	page.act(() => {
		if (
			!(
				element instanceof HTMLInputElement ||
				element instanceof HTMLTextAreaElement
			)
		)
			throw new Error("no field");
		const setter = Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(element),
			"value",
		)?.set;
		setter?.call(element, text);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});

test("a form starts with each field's initial value, filters a long list, and submits only what was given", async () => {
	const submitted: unknown[] = [];
	await page.render(
		<HostForm
			spec={{
				title: "Assign",
				submit: "Assign it",
				fields: [
					{
						name: "owner",
						label: "Owner",
						type: "select",
						required: true,
						search: true,
						initial: "mel",
						options: [
							{ value: "ada", label: "Ada" },
							{ value: "mel", label: "Mel" },
							{ value: "kim", label: "Kim" },
						],
					},
					{
						name: "tags",
						label: "Tags",
						type: "multiselect",
						initial: ["a"],
						options: [
							{ value: "a", label: "Alpha" },
							{ value: "b", label: "Beta" },
						],
					},
					{ name: "note", label: "Note", type: "textarea", max: 50 },
				],
			}}
			onSubmit={async (input) => {
				submitted.push(input);
				return undefined;
			}}
		/>,
	);
	const select = page.container.querySelector("select");
	expect(select?.value).toBe("mel");
	// The filter box narrows the listed options.
	expect([...(select?.options ?? [])].map((option) => option.text)).toEqual([
		"Ada",
		"Mel",
		"Kim",
	]);
	await typeInto(page.container.querySelector('input[type="search"]'), "ki");
	expect(
		[...(page.container.querySelector("select")?.options ?? [])].map(
			(option) => option.text,
		),
	).toEqual(["Kim"]);
	await typeInto(page.container.querySelector('input[type="search"]'), "");
	const boxes = [
		...page.container.querySelectorAll<HTMLInputElement>(
			'input[type="checkbox"]',
		),
	];
	expect(boxes.map((box) => box.checked)).toEqual([true, false]);
	await page.click(boxes[1] ?? null);
	await page.act(() => {
		page.container
			.querySelector("form")
			?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
	await settle();
	expect(submitted).toEqual([{ owner: "mel", tags: ["a", "b"] }]);
});

test("a refusal naming a field shows at that field, and one naming none shows under the form", async () => {
	let answer: { error: string; field?: string } = {
		error: "Pick someone else.",
		field: "owner",
	};
	await page.render(
		<HostForm
			spec={{
				title: "Assign",
				submit: "Go",
				fields: [{ name: "owner", label: "Owner", type: "text" }],
			}}
			onSubmit={async () => answer}
		/>,
	);
	const submit = async () => {
		await page.act(() => {
			page.container
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
		await settle();
	};
	await submit();
	expect(page.container.querySelector(".field-error")?.textContent).toBe(
		"Pick someone else.",
	);
	answer = { error: "The host is busy." };
	await submit();
	expect(page.container.querySelector(".field-error")).toBeNull();
	expect(page.container.querySelector('[role="alert"]')?.textContent).toBe(
		"The host is busy.",
	);
});
