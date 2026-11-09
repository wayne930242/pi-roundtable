import { expect, test } from "bun:test";
import type { ReadMarkView, RoomMessage } from "../src/api-types.ts";
import ReadLog from "./components/read-log.tsx";
import {
	hostPagesPage,
	ME,
	message,
	page,
	sent,
	settle,
	shown,
} from "./host-pages-fixture.tsx";
import { store } from "./lib/app-store.ts";
import * as hostState from "./lib/host-state.ts";

hostPagesPage();

const ROOM2 = "app:inbox.marks-room-0001";

function loadMessages(): RoomMessage[] {
	const messages = [1, 2, 3, 4, 5].map((id) =>
		message(id, {
			room: ROOM2,
			authorKind: "external",
			...(id === 4 ? { authorKind: "member", principalId: ME } : {}),
		}),
	);
	store.dispatch({
		type: "history_loaded",
		room: ROOM2,
		messages,
		more: false,
		older: false,
	});
	return messages;
}

test("a divider stands where the new messages began, and each reader's mark under the last message they read", async () => {
	loadMessages();
	const marks: ReadMarkView[] = [
		{
			principal: "p-mel",
			name: "Mel",
			upTo: 3,
			at: "2026-10-29T10:00:00.000Z",
		},
		{
			principal: "p-kim",
			name: "Kim",
			upTo: 3,
			at: "2026-10-29T10:00:01.000Z",
		},
		{ principal: ME, name: "Ada", upTo: 5, at: "2026-10-29T10:00:02.000Z" },
	];
	hostState.keepReads(ROOM2, marks, 2);
	const scroller = { current: null as HTMLElement | null };
	await shown(
		<div
			ref={(element) => {
				scroller.current = element;
			}}
		>
			<ReadLog
				roomKey={ROOM2}
				enterAfter={undefined}
				quotable={false}
				scroller={scroller}
				host
			/>
		</div>,
	);
	const order = [...page.container.querySelectorAll(".messages > li")].map(
		(item) =>
			item.classList.contains("new-divider")
				? "divider"
				: item.classList.contains("seen")
					? "seen"
					: (item.getAttribute("data-mid") ?? "?"),
	);
	// The cursor was 2: the divider goes before message 3, and the two readers of 3 are shown under it, the person themselves not.
	expect(order.slice(order.indexOf("divider"))).toEqual([
		"divider",
		"3",
		"seen",
		"4",
		"5",
	]);
	expect(page.container.querySelector(".seen")?.textContent).toContain(
		"Seen by 2",
	);
	await page.click(page.container.querySelector(".seen-toggle"));
	expect(page.container.querySelector(".seen-names")?.textContent).toBe(
		"Mel, Kim",
	);
});

test("in a host room the messages past the read marker wear a frame, the person's own do not, and a pointer passing over one clears it", async () => {
	loadMessages();
	hostState.keepReads(ROOM2, undefined, 2);
	const scroller = { current: null as HTMLElement | null };
	await shown(
		<div
			ref={(element) => {
				scroller.current = element;
			}}
		>
			<ReadLog
				roomKey={ROOM2}
				enterAfter={5}
				quotable={false}
				scroller={scroller}
				host
			/>
		</div>,
	);
	const framed = () =>
		[...page.container.querySelectorAll<HTMLElement>("li[data-unread]")].map(
			(item) => item.dataset.mid,
		);
	// The cursor was 2; message 4 is the person's own.
	expect(framed()).toEqual(["3", "5"]);
	const target = page.container.querySelector("li[data-mid='3'] .bubble");
	if (!target) throw new Error("no bubble");
	await page.act(() => {
		target.dispatchEvent(
			Object.assign(new Event("pointerover", { bubbles: true }), {
				pointerType: "mouse",
			}),
		);
	});
	expect(framed()).toEqual(["5"]);
});

const rects = new Map<string, { top: number; bottom: number }>();
function pretendLayout(): () => void {
	const realRect = HTMLElement.prototype.getBoundingClientRect;
	HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
		const at =
			this.dataset.mid !== undefined
				? rects.get(this.dataset.mid)
				: this.dataset.scroller !== undefined
					? { top: 0, bottom: 300 }
					: undefined;
		return {
			top: 0,
			bottom: 0,
			left: 0,
			right: 0,
			width: 0,
			height: 0,
			x: 0,
			y: 0,
			...at,
			toJSON: () => ({}),
		} as DOMRect;
	};
	return () => {
		HTMLElement.prototype.getBoundingClientRect = realRect;
	};
}

test("the server is told how far the person has read: the newest message in view, once a second at most, and never while the page is hidden", async () => {
	const restore = pretendLayout();
	try {
		const room = "app:inbox.track-room-0001";
		store.dispatch({
			type: "history_loaded",
			room,
			messages: [1, 2, 3, 4].map((id) => message(id, { room })),
			more: false,
			older: false,
		});
		rects.clear();
		// The viewport is 0–300: messages 1 and 2 are in it, 3 and 4 are below.
		rects.set("1", { top: 10, bottom: 60 });
		rects.set("2", { top: 100, bottom: 150 });
		rects.set("3", { top: 320, bottom: 370 });
		rects.set("4", { top: 400, bottom: 450 });
		const scroller = { current: null as HTMLElement | null };
		await shown(
			<div
				data-scroller=""
				ref={(element) => {
					scroller.current = element;
				}}
			>
				<ReadLog
					roomKey={room}
					enterAfter={undefined}
					quotable={false}
					scroller={scroller}
					host
				/>
			</div>,
		);
		await settle(60);
		const reads = () => sent.filter((frame) => frame.type === "read");
		expect(reads()).toEqual([{ type: "read", room, upTo: 2 }]);
		// Scrolling down brings 3 and 4 into view; the next report waits out the second.
		rects.set("3", { top: 120, bottom: 170 });
		rects.set("4", { top: 200, bottom: 250 });
		await page.act(() => {
			scroller.current?.dispatchEvent(new Event("scroll"));
		});
		await settle(100);
		expect(reads()).toHaveLength(1);
		await settle(1000);
		expect(reads().at(-1)).toEqual({ type: "read", room, upTo: 4 });
		expect(reads()).toHaveLength(2);
		// A hidden page reads nothing.
		Object.defineProperty(document, "visibilityState", {
			value: "hidden",
			configurable: true,
		});
		store.dispatch({ type: "message", room, message: message(5, { room }) });
		rects.set("5", { top: 260, bottom: 290 });
		await settle(1200);
		expect(reads()).toHaveLength(2);
	} finally {
		Object.defineProperty(document, "visibilityState", {
			value: "visible",
			configurable: true,
		});
		restore();
	}
});

// ── The list of a kind, and a page ────────────────────────────────────────────────────────────────
