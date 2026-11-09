import { expect, test } from "bun:test";
import type { RoomMessage } from "../src/api-types.ts";
import { ConfigContext } from "./components/../lib/config.ts";
import { GroupScene } from "./components/group-scene.tsx";
import { store } from "./lib/app-store.ts";
import {
	agent,
	arrive,
	CREW,
	config,
	crew,
	page,
	query,
	render,
	sceneTablePage,
	settle,
} from "./table-scene-page-fixture.tsx";

sceneTablePage();

const heard = (
	id: number,
	who: "owner" | "lena" | "otto",
	text: string,
): RoomMessage => ({
	id,
	room: CREW,
	kind: who === "owner" ? "owner" : "agent",
	...(who === "owner" ? {} : { agent: who }),
	author: who === "owner" ? "Ada" : who === "lena" ? "Lena" : "\u6885\u68ee",
	text,
	files: [],
	at: "2026-10-29T10:00:00.000Z",
});

/** Ids that keep rising across the tests, because the store keeps the room's messages between them. */
let seq = 10;
const nid = () => ++seq;

const say = (...messages: RoomMessage[]) =>
	store.dispatch({
		type: "history_loaded",
		room: CREW,
		messages,
		more: false,
		older: false,
	});

const lit = () =>
	[...page.container.querySelectorAll("g.seat[data-focus]")].map(
		(seat) => seat.getAttribute("aria-label")?.split(" ")[0],
	);

test("a group scene turns the camera to whoever speaks, and rests on the whole ring while the owner does", async () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [agent("lena", "Lena"), agent("otto", "\u6885\u68ee"), crew()],
	});
	say(heard(nid(), "owner", "Who has the plan?"));
	await page.render(
		<ConfigContext.Provider value={config}>
			<GroupScene roomKey={CREW} members={["lena", "otto"]} />
		</ConfigContext.Provider>,
	);
	await arrive();
	// the owner's line shows under the owner's name, and the camera is on the whole ring
	expect(query(".scene-name")?.textContent).toBe("Ada");
	expect(lit()).toEqual([]);
	expect(query(".scene-box")?.hasAttribute("data-open")).toBe(true);
	await page.act(() =>
		say(heard(nid(), "otto", "\u7246\u5df2\u7d93\u780c\u597d\u4e86。")),
	);
	expect(lit()).toEqual(["\u6885\u68ee"]);
	expect(query(".scene-name")?.textContent).toBe("\u6885\u68ee");
	await page.act(() => say(heard(nid(), "lena", "Then I take the roof.")));
	expect(lit()).toEqual(["Lena"]);
	await page.act(() => say(heard(nid(), "owner", "Thanks both.")));
	expect(lit()).toEqual([]);
	expect(query(".scene-name")?.textContent).toBe("Ada");
});

test("in a group, the box names the member at work under the owner's line, and folds its tools to one line a tap opens", async () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [agent("lena", "Lena"), agent("otto", "\u6885\u68ee"), crew()],
	});
	say(heard(nid(), "owner", "Check the notes."));
	await page.act(() => {
		store.dispatch({
			type: "activity",
			room: CREW,
			typing: true,
			stoppable: true,
			agent: "otto",
		});
	});
	await render(CREW);
	await arrive();
	await page.act(() => {
		store.dispatch({
			type: "progress",
			room: CREW,
			event: {
				type: "tool_start",
				id: "t1",
				tool: "search-notes",
				preview: "q",
			},
		});
		store.dispatch({
			type: "progress",
			room: CREW,
			event: { type: "tool_start", id: "t2", tool: "read" },
		});
	});
	expect(query(".scene-name")?.textContent).toBe("Ada");
	const fold = query<HTMLButtonElement>(".scene-box .progress-fold");
	expect(fold?.textContent).toContain("\u6885\u68ee is working");
	expect(fold?.textContent).not.toContain("Ada");
	expect(fold?.textContent).toContain("2 tools");
	expect(fold?.getAttribute("aria-expanded")).toBe("false");
	expect(query(".scene-box .chips")).toBeNull();
	await page.act(() => fold?.click());
	expect(fold?.getAttribute("aria-expanded")).toBe("true");
	expect(query(".scene-box .chips")?.textContent).toContain("search-notes");
	await page.act(() =>
		store.dispatch({
			type: "activity",
			room: CREW,
			typing: false,
			stoppable: false,
		}),
	);
});

test("a seat the person taps turns the camera there until the next line comes", async () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [agent("lena", "Lena"), agent("otto", "\u6885\u68ee"), crew()],
	});
	say(heard(nid(), "lena", "I am here."));
	await page.render(
		<ConfigContext.Provider value={config}>
			<GroupScene roomKey={CREW} members={["lena", "otto"]} />
		</ConfigContext.Provider>,
	);
	await settle(160);
	expect(lit()).toEqual(["Lena"]);
	const otto = page.container.querySelector<SVGGElement>(
		'g.seat[aria-label^="\u6885\u68ee"]',
	);
	await page.act(() => {
		otto?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(lit()).toEqual(["\u6885\u68ee"]);
	await page.act(() => say(heard(nid(), "lena", "Back to me.")));
	expect(lit()).toEqual(["Lena"]);
});

test("a speaker change while the owner is typing does not take the focus from the message box", async () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [agent("lena", "Lena"), agent("otto", "\u6885\u68ee"), crew()],
	});
	say(heard(nid(), "lena", "First."));
	await page.render(
		<ConfigContext.Provider value={config}>
			<GroupScene roomKey={CREW} members={["lena", "otto"]} />
		</ConfigContext.Provider>,
	);
	await settle(160);
	const box = query<HTMLTextAreaElement>(".scene-box textarea");
	box?.focus();
	expect(document.activeElement).toBe(box);
	await page.act(() => say(heard(nid(), "otto", "Second.")));
	expect(lit()).toEqual(["\u6885\u68ee"]);
	expect(document.activeElement).toBe(query(".scene-box textarea"));
	expect(query<HTMLTextAreaElement>(".scene-box textarea")).toBe(box);
});
