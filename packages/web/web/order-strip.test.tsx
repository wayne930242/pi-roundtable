import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { RoomView, RoundView } from "../src/api-types.ts";
import { OrderStrip } from "./components/order-strip.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { store } from "./lib/app-store.ts";
import { loadKit } from "./lib/kit.ts";

const CREW = "app:group.crew";

const agent = (name: string): RoomView => ({
	key: `app:agent.${name}`,
	kind: "agent",
	name,
	displayName: name.toUpperCase(),
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
});

const crew: RoomView = {
	key: CREW,
	kind: "group",
	name: "crew",
	displayName: "Crew",
	home: false,
	readOnly: false,
	members: ["guide", "scout", "mason"],
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
};

const round = (over: Partial<RoundView> = {}): RoundView => ({
	id: 1,
	state: "running",
	next: [],
	spoken: [],
	replies: 0,
	limit: 8,
	...over,
});

let page: TestPage;
beforeAll(async () => {
	await loadKit();
	page = await openPage();
});
afterEach(async () => {
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [] });
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

const show = async (frame?: RoundView) => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [agent("guide"), agent("scout"), agent("mason"), crew],
	});
	if (frame) store.dispatch({ type: "round", room: CREW, round: frame });
	await page.render(<OrderStrip roomKey={CREW} />);
};
const faces = () =>
	[...page.container.querySelectorAll(".order-face")].map((face) => [
		face.getAttribute("data-place"),
		face.getAttribute("title"),
		face.querySelector(".order-badge")?.textContent ?? "",
	]);
const chip = () => page.container.querySelector(".order-chip")?.textContent;

test("nothing shows until a round has run in the room", async () => {
	await show();
	expect(page.container.querySelector(".order-strip")).toBeNull();
});

test("a running round lists who spoke with a check, who speaks, and who is next with numbers, and says which reply it is on", async () => {
	await show(
		round({
			spoken: ["guide"],
			current: "scout",
			next: ["mason", "guide"],
			replies: 1,
		}),
	);
	expect(faces()).toEqual([
		["spoken", "GUIDE", "✓"],
		["current", "SCOUT", ""],
		["next", "MASON", "1"],
		["next", "GUIDE", "2"],
	]);
	expect(chip()).toBe("Reply 2 of 8");
});

test("the strip follows the round's frames, and each end says how it ended", async () => {
	await show(round({ current: "guide", next: ["scout"] }));
	expect(chip()).toBe("Reply 1 of 8");
	const send = (over: Partial<RoundView>) =>
		page.act(() =>
			store.dispatch({ type: "round", room: CREW, round: round(over) }),
		);
	await send({
		state: "ended",
		ended: "done",
		spoken: ["guide", "scout"],
		replies: 2,
	});
	expect(chip()).toBe("2 of 8 replies");
	expect(
		page.container.querySelector(".order-strip")?.getAttribute("data-state"),
	).toBe("ended");
	await send({
		state: "ended",
		ended: "limit",
		spoken: ["guide", "scout"],
		next: ["guide"],
		replies: 8,
	});
	expect(chip()).toBe("Limit reached");
	await send({
		state: "ended",
		ended: "stopped",
		spoken: ["guide"],
		replies: 1,
	});
	expect(chip()).toBe("Round stopped");
});

test("an owner message waiting for the next round is said while the round runs", async () => {
	await show(round({ current: "guide", queued: 1 }));
	expect(page.container.querySelector(".order-queued")?.textContent).toBe(
		"Your message waits for the next round",
	);
	await page.act(() =>
		store.dispatch({
			type: "round",
			room: CREW,
			round: round({ current: "guide" }),
		}),
	);
	expect(page.container.querySelector(".order-queued")).toBeNull();
});

test("a screen reader hears each face's place, and the list is named", async () => {
	await show(round({ spoken: ["guide"], current: "scout", next: ["mason"] }));
	expect(
		page.container.querySelector(".order-faces")?.getAttribute("aria-label"),
	).toBe("Speaking order");
	const heard = [...page.container.querySelectorAll(".visually-hidden")].map(
		(one) => one.textContent,
	);
	expect(heard).toEqual([
		"GUIDE, has spoken",
		"SCOUT, speaking",
		"MASON, next",
	]);
});
