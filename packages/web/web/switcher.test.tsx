import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "bun:test";
import type { PromptFrame, RoomMessage, RoomView } from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { Composer } from "./components/composer.tsx";
import { RoomSwitcher, useSwitcher } from "./components/switcher.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu } from "./lib/action-menu.ts";
import { store } from "./lib/app-store.ts";
import { clearDrafts, draftOf } from "./lib/drafts.ts";
import { loadKit } from "./lib/kit.ts";
import { setRouting } from "./lib/router.ts";
import { closeTeamSheet, currentTeamSheet } from "./lib/team-sheet.ts";

const GUIDE = "app:agent.guide";
const SCOUT = "app:agent.scout";
const BUILD = "app:agent.build";

const view = (key: string, over: Partial<RoomView> = {}): RoomView => ({
	key,
	kind: "agent",
	name: key.slice(key.indexOf(".") + 1),
	displayName: key.slice(key.indexOf(".") + 1),
	home: key === GUIDE,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

const said = (key: string, at: string): RoomMessage => ({
	id: 1,
	room: key,
	kind: "agent",
	author: "x",
	text: "hi",
	files: [],
	at,
});

const approval = (id: string): PromptFrame =>
	({
		id,
		kind: "approval",
		title: "Send it?",
		message: "Send the note",
		purpose: "action",
	}) as PromptFrame;

/** A room's page in little: the hook, the message list it swipes over, and the drawer. */
function Room(props: { current?: string }) {
	const switcher = useSwitcher(true);
	return (
		<div>
			<button type="button" id="avatar" onClick={switcher.show}>
				avatar
			</button>
			<div id="list" {...switcher.surface}>
				<pre id="code" />
				<div id="options" data-swipe-ignore />
				<div id="plain">message</div>
				<textarea id="box" />
			</div>
			<RoomSwitcher {...switcher.drawer} current={props.current ?? GUIDE} />
			<ActionMenuHost />
		</div>
	);
}

let page: TestPage;
beforeAll(async () => {
	await loadKit();
	page = await openPage();
	setRouting(undefined);
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

beforeEach(() => {
	window.innerWidth = 390;
	window.location.hash = "#/room/app%3Aagent.guide";
	store.dispatch({
		type: "rooms_loaded",
		rooms: [
			view(GUIDE, { last: said(GUIDE, "2026-10-28T10:00:00.000Z") }),
			view(SCOUT, { last: said(SCOUT, "2026-10-28T12:00:00.000Z") }),
			view(BUILD, { last: said(BUILD, "2026-10-28T11:00:00.000Z") }),
		],
	});
});
afterEach(async () => {
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [] });
	clearDrafts();
});

const element = (id: string): HTMLElement => {
	const found = page.container.querySelector<HTMLElement>(`#${id}`);
	if (!found) throw new Error(`no #${id}`);
	return found;
};
const drawer = () =>
	page.container.querySelector<HTMLElement>(".switcher")?.dataset.state;
const rowNames = () =>
	[...page.container.querySelectorAll(".switcher-row strong")].map(
		(one) => one.textContent,
	);
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** A touch event at a point and time, the way the browser reports a finger. */
function touch(
	target: Element,
	type: "pointerdown" | "pointermove" | "pointerup",
	x: number,
	y: number,
	at: number,
): void {
	const event = new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: x,
		clientY: y,
		pointerId: 1,
		pointerType: "touch",
		isPrimary: true,
	});
	// React reads a timestamp of 0 as none and takes the wall clock, so the test's clock starts later.
	Object.defineProperty(event, "timeStamp", { value: 10_000 + at });
	target.dispatchEvent(event);
}

/** A finger that goes from one point to another in `ms`, in three steps. */
async function swipe(
	target: Element,
	from: [number, number],
	to: [number, number],
	ms: number,
): Promise<void> {
	await page.act(() => {
		touch(target, "pointerdown", from[0], from[1], 0);
		for (const step of [1, 2, 3])
			touch(
				target,
				"pointermove",
				from[0] + ((to[0] - from[0]) * step) / 3,
				from[1] + ((to[1] - from[1]) * step) / 3,
				(ms * step) / 3,
			);
		touch(target, "pointerup", to[0], to[1], ms);
	});
}

test("a slow swipe right over the messages opens the drawer past 40 % of its width, and pushes a history entry", async () => {
	await page.render(<Room />);
	expect(drawer()).toBe("closed");
	const before = history.length;
	// 160 px of a 312 px drawer, slowly.
	await swipe(element("plain"), [100, 300], [260, 305], 900);
	expect(drawer()).toBe("open");
	expect(history.length).toBe(before + 1);
});

test("a short slow swipe leaves it closed, and a quick flick opens it", async () => {
	await page.render(<Room />);
	const before = history.length;
	await swipe(element("plain"), [100, 300], [200, 300], 900);
	expect(drawer()).toBe("closed");
	expect(history.length).toBe(before);
	await swipe(element("plain"), [100, 300], [160, 300], 60);
	expect(drawer()).toBe("open");
});

test("a swipe that starts within 32 px of either screen edge is ignored and leaves Back to the system", async () => {
	await page.render(<Room />);
	const before = history.length;
	for (const x of [0, 20, 31]) {
		await swipe(element("plain"), [x, 300], [x + 250, 300], 400);
		expect(drawer()).toBe("closed");
	}
	// A leftward swipe from the right edge opens nothing either.
	await swipe(element("plain"), [380, 300], [130, 300], 400);
	expect(drawer()).toBe("closed");
	expect(history.length).toBe(before);
	// The same swipe from just inside the guard opens it.
	await swipe(element("plain"), [32, 300], [282, 300], 400);
	expect(drawer()).toBe("open");
});

test("mostly vertical motion, and a leftward swipe, open nothing", async () => {
	await page.render(<Room />);
	await swipe(element("plain"), [100, 300], [160, 420], 300);
	expect(drawer()).toBe("closed");
	await swipe(element("plain"), [250, 300], [100, 300], 300);
	expect(drawer()).toBe("closed");
});

test("a swipe that starts in a field, a card's option row, or something scrolling sideways is not ours", async () => {
	await page.render(<Room />);
	await swipe(element("box"), [100, 300], [300, 300], 400);
	expect(drawer()).toBe("closed");
	await swipe(element("options"), [100, 300], [300, 300], 400);
	expect(drawer()).toBe("closed");
	const code = element("code");
	code.style.overflowX = "auto";
	Object.defineProperty(code, "scrollWidth", { value: 900 });
	Object.defineProperty(code, "clientWidth", { value: 300 });
	await swipe(code, [100, 300], [300, 300], 400);
	expect(drawer()).toBe("closed");
	// The same swipe over plain message text does open it.
	await swipe(element("plain"), [100, 300], [300, 300], 400);
	expect(drawer()).toBe("open");
});

test("the header avatar opens the same drawer", async () => {
	await page.render(<Room />);
	await page.click(element("avatar"));
	expect(drawer()).toBe("open");
	expect(page.container.querySelector(".switcher-panel")).not.toBeNull();
});

test("the drawer's + button offers the add menu; choosing New agent closes the drawer and asks for its sheet", async () => {
	await page.render(<Room />);
	await page.click(element("avatar"));
	expect(drawer()).toBe("open");
	await page.click(
		page.container.querySelector('.switcher-search button[aria-label="Add"]'),
	);
	await page.act(async () => {
		await settle(60);
	});
	const items = [
		...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
	];
	expect(items.map((one) => one.textContent)).toEqual([
		"New agent",
		"New group",
		"Archived",
	]);
	await page.click(items[0] ?? null);
	await page.act(async () => {
		await settle(120);
	});
	expect(drawer()).toBe("closed");
	expect(currentTeamSheet()).toMatchObject({ kind: "new-agent" });
	closeTeamSheet();
	await page.act(() => closeMenu());
});

test("the system Back closes the drawer before it leaves the room", async () => {
	await page.render(<Room />);
	const where = location.href;
	await page.click(element("avatar"));
	expect(drawer()).toBe("open");
	await page.act(async () => {
		history.back();
		await settle();
	});
	expect(drawer()).toBe("closed");
	expect(location.href).toBe(where);
});

test("a swipe left, a tap outside and Escape each close it", async () => {
	await page.render(<Room />);
	await page.click(element("avatar"));
	// The panel's own swipe left closes it.
	const panel = page.container.querySelector(".switcher-panel") as HTMLElement;
	await page.act(async () => {
		touch(panel, "pointerdown", 250, 300, 1000);
		touch(panel, "pointermove", 200, 300, 1050);
		touch(panel, "pointermove", 120, 300, 1100);
		touch(panel, "pointerup", 120, 300, 1110);
		await settle();
	});
	expect(drawer()).toBe("closed");

	await page.click(element("avatar"));
	expect(drawer()).toBe("open");
	await page.act(async () => {
		(page.container.querySelector(".switcher-scrim") as HTMLElement).click();
		await settle();
	});
	expect(drawer()).toBe("closed");

	await page.click(element("avatar"));
	await page.act(async () => {
		page.container
			.querySelector(".switcher")
			?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		await settle();
	});
	expect(drawer()).toBe("closed");
});

test("rooms with a waiting card sit on top, the rest by latest activity", async () => {
	await page.render(<Room />);
	await page.click(element("avatar"));
	expect(rowNames()).toEqual(["scout", "build", "guide"]);
	await page.act(() => {
		store.dispatch({ type: "prompt", room: GUIDE, prompt: approval("p1") });
	});
	expect(rowNames()).toEqual(["guide", "scout", "build"]);
	expect(
		page.container.querySelectorAll(".switcher-row .badge-warn"),
	).toHaveLength(1);
});

test("a tap on a row switches the room in place: the drawer closes and the route changes", async () => {
	await page.render(<Room />);
	await page.click(element("avatar"));
	const row = [...page.container.querySelectorAll(".switcher-row")].find(
		(one) => one.textContent?.includes("scout"),
	) as HTMLElement;
	await page.act(async () => {
		row.click();
		await settle(60);
	});
	expect(drawer()).toBe("closed");
	expect(location.hash).toBe(`#/room/${encodeURIComponent(SCOUT)}`);
});

test("the search field narrows the rows", async () => {
	await page.render(<Room />);
	await page.click(element("avatar"));
	const input = page.container.querySelector(
		".switcher-search input",
	) as HTMLInputElement;
	await page.act(() => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(input, "bui");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(rowNames()).toEqual(["build"]);
});

test("each room keeps its unsent text when the person leaves it and comes back", async () => {
	const type = async (value: string) => {
		const box = page.container.querySelector("textarea") as HTMLTextAreaElement;
		await page.act(() => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setter?.call(box, value);
			box.dispatchEvent(new Event("input", { bubbles: true }));
		});
	};
	const composer = (room: string) => (
		<Composer
			key={room}
			draftKey={room}
			name={room}
			limits={undefined}
			stoppable={false}
			onSend={() => undefined}
			onStop={() => undefined}
		/>
	);
	const box = () =>
		(page.container.querySelector("textarea") as HTMLTextAreaElement).value;

	await page.render(composer(GUIDE));
	await type("half a thought");
	expect(draftOf(GUIDE)).toBe("half a thought");
	await page.render(composer(SCOUT));
	expect(box()).toBe("");
	await type("look at the disk");
	await page.render(composer(GUIDE));
	expect(box()).toBe("half a thought");
	await page.render(composer(SCOUT));
	expect(box()).toBe("look at the disk");
	await page.render(composer(BUILD));
	expect(box()).toBe("");
});

test("a muted room shows the bell-slash in the drawer, and only that room", async () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [
			view(GUIDE, { last: said(GUIDE, "2026-10-28T10:00:00.000Z") }),
			view(SCOUT, {
				last: said(SCOUT, "2026-10-28T12:00:00.000Z"),
				muted: true,
			}),
			view(BUILD, { last: said(BUILD, "2026-10-28T11:00:00.000Z") }),
		],
	});
	await page.render(<Room />);
	await page.click(element("avatar"));
	const marked = [...page.container.querySelectorAll(".switcher-row")]
		.filter((row) => row.querySelector('[data-mode="muted"]'))
		.map((row) => row.querySelector("strong")?.textContent);
	expect(marked).toEqual(["scout"]);
	expect(
		page.container.querySelector('[data-mode="muted"]')?.getAttribute("title"),
	).toBe("Notifications are off");
});
