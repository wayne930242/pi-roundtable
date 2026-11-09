import { expect, test } from "bun:test";
import { ConfigContext } from "./components/../lib/config.ts";
import { DialogueBox } from "./components/dialogue-box.tsx";
import { GroupScene } from "./components/group-scene.tsx";
import { store } from "./lib/app-store.ts";
import { draftOf } from "./lib/drafts.ts";
import { DIALOGUE_FOLD_CSS } from "./lib/table-page-style.ts";
import {
	DIALOGUE_FOLDED_KEY,
	resetTableView,
	setDialogueFolded,
} from "./lib/table-view.ts";
import {
	agent,
	arrive,
	CREW,
	config,
	crew,
	MASON,
	page,
	query,
	render,
	reply,
	SCOUT,
	sceneTablePage,
	sent,
	setReduced,
	settle,
} from "./table-scene-page-fixture.tsx";

sceneTablePage();

const NOVA = "app:agent.nova";

test("the box on an agent's room names that agent on the plate and shows its newest line", async () => {
	await render(SCOUT);
	await settle();
	const box = query(".scene-box");
	expect(box).not.toBeNull();
	expect(box?.querySelector(".scene-name")?.textContent).toBe("Lena");
	expect(box?.textContent).toContain("Found");
	// the room's own composer is under it
	expect(box?.querySelector("textarea")).not.toBeNull();
	await render(MASON);
	await settle();
	expect(query(".scene-name")?.textContent).toBe("\u6885\u68ee");
});

test("an agent's room keeps that agent's name on the plate and in the progress line while the newest line is the owner's", async () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [
			agent("lena", "Lena"),
			agent("otto", "\u6885\u68ee"),
			agent("nova", "Nova"),
		],
	});
	store.dispatch({
		type: "message",
		room: NOVA,
		message: {
			id: 2,
			room: NOVA,
			kind: "owner",
			author: "Ada",
			text: "stream",
			files: [],
			at: "2026-10-29T10:01:00.000Z",
		},
	});
	await page.act(() =>
		store.dispatch({
			type: "activity",
			room: NOVA,
			typing: true,
			stoppable: true,
		}),
	);
	await render(NOVA);
	await arrive();
	expect(query(".scene-name")?.textContent).toBe("Nova");
	expect(query(".scene-chip")).not.toBeNull();
	// the owner's words stay, marked as theirs
	expect(query(".scene-from")?.textContent).toBe("Ada");
	expect(query(".scene-line")?.textContent).toContain("stream");
	expect(query(".scene-box")?.textContent).toContain("Nova");
	expect(query(".scene-box")?.textContent).not.toContain("Ada is");
});

/** Frames and a clock the test turns by hand, so the typing can be watched half way and `act` has no chain of frames to wait out. */
function manualFrames() {
	const realFrame = window.requestAnimationFrame;
	const realCancel = window.cancelAnimationFrame;
	const realNow = performance.now.bind(performance);
	// a whole number, so that adding to it and subtracting it again gives back exactly what was added
	let clock = Math.ceil(realNow());
	let next = 1;
	const queue = new Map<number, FrameRequestCallback>();
	window.requestAnimationFrame = (callback) => {
		queue.set(next, callback);
		return next++;
	};
	window.cancelAnimationFrame = (id) => void queue.delete(id);
	performance.now = () => clock;
	return {
		/** Moves the clock on by `ms` and runs the frames asked for so far. */
		async advance(ms: number) {
			clock += ms;
			const due = [...queue.entries()];
			queue.clear();
			await page.act(() => {
				for (const [, callback] of due) callback(clock);
			});
		},
		restore() {
			window.requestAnimationFrame = realFrame;
			window.cancelAnimationFrame = realCancel;
			performance.now = realNow;
		},
	};
}

test("a streaming reply types out, and a tap on it shows the whole text", async () => {
	const frames = manualFrames();
	try {
		await render(SCOUT);
		await arrive();
		// the room's last words still type out; the stream waits for them, so a tap shows them whole first
		await page.click(query<HTMLElement>(".scene-line"));
		const words =
			`Streaming along nicely ${"with a fairly long sentence ".repeat(30)}`.trim();
		await page.act(() => {
			store.dispatch({
				type: "activity",
				room: SCOUT,
				typing: true,
				stoppable: true,
			});
			store.dispatch({
				type: "progress",
				room: SCOUT,
				event: { type: "text", delta: words },
			});
		});
		await frames.advance(100);
		const early = query(".scene-line")?.textContent ?? "";
		// nine characters in a tenth of a second at 90 a second
		expect(early).toBe(words.slice(0, 9));
		await frames.advance(1000);
		const later = query(".scene-line")?.textContent ?? "";
		expect(later.length).toBeGreaterThan(early.length);
		expect(later.length).toBeLessThan(words.length / 2);
		const line = query<HTMLElement>(".scene-line");
		expect(line?.getAttribute("role")).toBe("button");
		await page.click(line);
		expect(query(".scene-line")?.textContent).toBe(words);
		// all of it shows, so there is nothing left to tap
		expect(query(".scene-line")?.getAttribute("role")).toBeNull();
	} finally {
		frames.restore();
	}
});

test("under reduced motion the whole text shows at once", async () => {
	setReduced(true);
	await render(SCOUT);
	await settle(30);
	expect(query(".scene-line")?.textContent).toContain("Found three leads.");
	expect(query(".scene-line")?.getAttribute("role")).toBeNull();
});

test("a card that waits shows in the box, and answering it there answers the room's card", async () => {
	await render(SCOUT);
	await arrive();
	await page.act(() => {
		store.dispatch({
			type: "prompt",
			room: SCOUT,
			prompt: {
				id: "p1",
				kind: "approval",
				title: "Run the deploy?",
				message: "Deploy it.",
				purpose: "action",
			},
		});
	});
	await settle(30);
	const card = query(".scene-card");
	expect(card?.textContent).toContain("Run the deploy?");
	const approve = [...(card?.querySelectorAll("button") ?? [])].find(
		(button) => button.textContent === "Approve",
	);
	expect(approve).toBeDefined();
	await page.click(approve ?? null);
	expect(sent).toContainEqual({
		type: "approval",
		prompt: "p1",
		approved: true,
	});
});

test("each room keeps what was typed and not sent while the table turns to another agent", async () => {
	await render(SCOUT);
	await arrive();
	const type = async (value: string) => {
		const box = query<HTMLTextAreaElement>(".scene-box textarea");
		await page.act(() => {
			if (!box) return;
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setter?.call(box, value);
			box.dispatchEvent(new Event("input", { bubbles: true }));
		});
	};
	await type("remember the milk");
	expect(draftOf(SCOUT)).toBe("remember the milk");
	await render(MASON);
	await settle(30);
	expect(query<HTMLTextAreaElement>(".scene-box textarea")?.value).toBe("");
	await type("\u7246\u8981\u518d\u9ad8\u4e00\u9ede");
	expect(draftOf(MASON)).toBe("\u7246\u8981\u518d\u9ad8\u4e00\u9ede");
	await render(SCOUT);
	await settle(30);
	expect(query<HTMLTextAreaElement>(".scene-box textarea")?.value).toBe(
		"remember the milk",
	);
});

test("the Log button opens the room's whole message list over the scene", async () => {
	await render(SCOUT);
	await arrive();
	const open = query<HTMLButtonElement>(".scene-log-button");
	await page.click(open);
	await settle(40);
	expect(query(".scene-log .messages")?.textContent).toContain(
		"Found three leads.",
	);
});

const reads = () => sent.filter((frame) => frame.type === "read");

const setVisibility = (value: DocumentVisibilityState) =>
	Object.defineProperty(document, "visibilityState", {
		value,
		configurable: true,
	});

const READER = "app:agent.ivy";

test("a message counts as read once the box shows it: not while it waits behind another, and not while the page is hidden", async () => {
	// A room of its own: the store keeps a room's messages from one test to the next.
	store.dispatch({
		type: "rooms_loaded",
		rooms: [
			agent("lena", "Lena"),
			agent("otto", "\u6885\u68ee"),
			agent("ivy", "Ivy"),
		],
	});
	store.dispatch({
		type: "history_loaded",
		room: READER,
		messages: [reply(1, READER, "ivy", "Ivy", "First.")],
		more: false,
		older: false,
	});
	const said = (id: number, text: string) =>
		store.dispatch({
			type: "message",
			room: READER,
			message: reply(id, READER, "ivy", "Ivy", text),
		});
	const frames = manualFrames();
	try {
		await render(READER);
		await arrive();
		expect(reads()).toEqual([{ type: "read", room: READER, upTo: 1 }]);
		await frames.advance(100);
		// Two replies at once: the long first one types out, the second waits behind it unread.
		await page.act(() => {
			said(2, "word ".repeat(80));
			said(3, "Done.");
		});
		await frames.advance(100);
		await settle(1100);
		expect(reads().at(-1)).toEqual({ type: "read", room: READER, upTo: 2 });
		expect(reads().some((frame) => frame.upTo === 3)).toBe(false);
		// A tap shows the first whole, the box moves on to the second, and that one is read.
		await page.click(query(".scene-line"));
		await settle(1100);
		expect(reads().at(-1)).toEqual({ type: "read", room: READER, upTo: 3 });
		await frames.advance(100);
		const before = reads().length;
		// Shown while the page is hidden, a message is read once the page shows again.
		setVisibility("hidden");
		try {
			await page.act(() => said(4, "Next."));
			await frames.advance(100);
			await settle(1100);
			expect(reads()).toHaveLength(before);
		} finally {
			setVisibility("visible");
		}
		await page.act(() => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await settle(40);
		expect(reads().at(-1)).toEqual({ type: "read", room: READER, upTo: 4 });
	} finally {
		frames.restore();
	}
}, 10_000);

test("the open Log reads as the chat log does: the newest message in its view", async () => {
	const realRect = HTMLElement.prototype.getBoundingClientRect;
	// The log's view is 0–300 and every message stands in it.
	HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
		const at = this.classList.contains("scene-log")
			? { top: 0, bottom: 300 }
			: this.dataset.mid !== undefined
				? { top: 10, bottom: 60 }
				: { top: 0, bottom: 0 };
		return {
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
	try {
		// A box slid down shows no line, so only the log reads.
		await page.render(
			<ConfigContext.Provider value={config}>
				<DialogueBox roomKey={SCOUT} open={false} />
			</ConfigContext.Provider>,
		);
		await arrive();
		expect(reads()).toEqual([]);
		await page.click(query(".scene-log-button"));
		await settle(60);
		expect(reads()).toEqual([{ type: "read", room: SCOUT, upTo: 1 }]);
	} finally {
		HTMLElement.prototype.getBoundingClientRect = realRect;
	}
});

test("the box's last button folds it, labelled, and the folded box is one bar that a tap opens again; the choice stays on the device", async () => {
	await render(SCOUT);
	await arrive();
	const toggle = () => query<HTMLButtonElement>(".scene-collapse");
	const shape = (button: Element | null) =>
		button?.querySelector("path")?.getAttribute("d");
	const turn = () => toggle()?.querySelector("svg")?.style.rotate;
	// A chevron with words beside it, not the dots of More.
	expect(shape(toggle())).toBe("M9 6l6 6-6 6");
	expect(shape(toggle())).not.toBe(shape(query(".scene-more")));
	expect(toggle()?.textContent).toBe("Collapse dialogue");
	expect(turn()).toBe("90deg");
	expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
	expect(query(".scene-bar")).toBeNull();
	await page.click(toggle());
	const box = query(".scene-box");
	expect(box?.hasAttribute("data-collapsed")).toBe(true);
	// Folded, nothing but the bar shows: no tab, no line, no strip; the composer keeps its text out of sight.
	expect(query(".scene-tab")).toBeNull();
	expect(query(".scene-body")).toBeNull();
	expect(query(".order-strip")).toBeNull();
	expect(query<HTMLElement>(".scene-composer")?.hidden).toBe(true);
	const bar = query(".scene-bar");
	expect(bar?.querySelector(".scene-bar-name")?.textContent).toBe("Lena");
	expect(bar?.querySelector(".scene-bar-preview")?.textContent).toBe(
		"Found three leads.",
	);
	// The button on the bar says it opens the box, and the chevron turns.
	expect(toggle()?.closest(".scene-bar")).toBe(bar);
	expect(toggle()?.textContent).toBe("Expand dialogue");
	expect(turn()).toBe("-90deg");
	expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
	expect(localStorage.getItem(DIALOGUE_FOLDED_KEY)).toBe("1");
	// A page that comes back to it finds it folded.
	resetTableView();
	await page.render(null);
	await render(SCOUT);
	await arrive();
	expect(query(".scene-bar")).not.toBeNull();
	// A tap anywhere on the bar opens the box.
	await page.click(query(".scene-bar-preview"));
	expect(query(".scene-bar")).toBeNull();
	expect(query(".scene-box")?.hasAttribute("data-collapsed")).toBe(false);
	expect(query(".scene-body")).not.toBeNull();
	expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
	expect(localStorage.getItem(DIALOGUE_FOLDED_KEY)).toBe("0");
	// The bar's own button opens it too, once.
	await page.click(toggle());
	await page.click(toggle());
	expect(query(".scene-bar")).toBeNull();
});

test("on an upright phone a folded box gives the scene its height: the frame says so, and the box's row is only as tall as the bar", async () => {
	setDialogueFolded(true);
	store.dispatch({
		type: "rooms_loaded",
		rooms: [agent("lena", "Lena"), agent("otto", "\u6885\u68ee"), crew()],
	});
	await page.render(
		<ConfigContext.Provider value={config}>
			<GroupScene roomKey={CREW} members={["lena", "otto"]} />
		</ConfigContext.Provider>,
	);
	await arrive();
	expect(query(".room-scene")?.hasAttribute("data-folded")).toBe(true);
	const portrait = DIALOGUE_FOLD_CSS.slice(
		DIALOGUE_FOLD_CSS.indexOf(
			"@media (max-width: 719px) and (orientation: portrait)",
		),
	);
	expect(portrait).toContain(
		".table-frame[data-focused][data-folded] {\n\t\tgrid-template-rows: minmax(0, 1fr) auto;",
	);
	await page.click(query(".scene-collapse"));
	expect(query(".room-scene")?.hasAttribute("data-folded")).toBe(false);
});
