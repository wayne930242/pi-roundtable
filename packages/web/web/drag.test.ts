import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { type Lift, lift, type Outcome } from "./lib/drag.ts";

// happy-dom has no layout, so each element is given the box it would have; the driver's
// measuring, painting and cleaning are checked against those.
let page: TestPage;
beforeAll(async () => {
	page = await openPage();
	Object.defineProperty(window, "innerHeight", {
		value: 800,
		configurable: true,
	});
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});
afterEach(() => {
	document.body.replaceChildren();
});

const box = (el: Element, top: number, height: number, width = 300) => {
	el.getBoundingClientRect = () =>
		({
			top,
			bottom: top + height,
			left: 0,
			right: width,
			width,
			height,
			x: 0,
			y: top,
			toJSON: () => ({}),
		}) as DOMRect;
};
/** An element with attributes and children, built without parsing markup. */
const el = (
	tag: string,
	attrs: Record<string, string> = {},
	...children: HTMLElement[]
): HTMLElement => {
	const node = document.createElement(tag);
	for (const [name, value] of Object.entries(attrs))
		node.setAttribute(name, value);
	node.append(...children);
	return node;
};
const row = (key: string) =>
	el("li", { "data-drop-item": "", "data-key": key });
const zone = (kind: string, id: string, ...items: HTMLElement[]) =>
	el(
		"section",
		{
			"data-drop-zone": kind,
			"data-zone-id": id,
			...(kind === "folder" ? { "data-folder": id } : {}),
		},
		el("ul", {}, ...items),
	);
const pointer = (type: string, y: number, id = 1) => {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: 50,
		clientY: y,
	});
	Object.defineProperty(event, "pointerId", { value: id });
	window.dispatchEvent(event);
};
const frames = () => new Promise((resolve) => setTimeout(resolve, 30));

/** A pinned list (A B), a folder (C) and the rest (D), laid out one under the other. */
function page5() {
	const pinned = zone("pinned", "pinned", row("A"), row("B"));
	const folder = zone("folder", "f1", row("C"));
	const rest = zone("rest", "rest", row("D"));
	const root = el("div", { "data-drop-root": "" }, pinned, folder, rest);
	document.body.append(root);
	box(root, 100, 500);
	box(pinned, 100, 116);
	box(folder, 240, 56);
	box(rest, 320, 56);
	const rows: Record<string, HTMLElement> = {};
	for (const [key, top] of [
		["A", 100],
		["B", 160],
		["C", 240],
		["D", 320],
	] as const) {
		const one = root.querySelector(`[data-key="${key}"]`) as HTMLElement;
		box(one, top, 56);
		rows[key] = one;
	}
	return { root, rows, pinned, folder, rest };
}

const start = (item: HTMLElement, root: HTMLElement, y: number) => {
	const done: Outcome[] = [];
	const opened: string[] = [];
	const options: Lift = {
		mode: "room",
		item,
		key: item.dataset.key ?? "",
		pointerId: 1,
		y,
		root,
		open: (folder) => opened.push(folder),
		done: (outcome) => done.push(outcome),
	};
	return { stop: lift(options), done, opened };
};

test("a lifted row follows the finger, the others in its list move over, and a drop names its place", async () => {
	const { root, rows } = page5();
	const run = start(rows.A as HTMLElement, root, 120);
	expect(rows.A?.hasAttribute("data-lifted")).toBe(true);
	expect(root.hasAttribute("data-reordering")).toBe(true);
	// Down to B's lower half: A lands after B.
	pointer("pointermove", 200);
	await frames();
	expect(rows.A?.style.transform).toBe("translate3d(0, 80px, 0)");
	expect(rows.B?.style.transform).toBe("translate3d(0, -60px, 0)");
	expect(
		root.querySelector("[data-drop-target]")?.getAttribute("data-zone-id"),
	).toBe("pinned");
	pointer("pointerup", 200);
	expect(run.done).toHaveLength(1);
	const outcome = run.done[0];
	expect(outcome).toMatchObject({ type: "room", drop: { before: null } });
	expect((outcome as { drop: { zone: { id: string } } }).drop.zone.id).toBe(
		"pinned",
	);
	// Everything painted is taken away.
	expect(rows.A?.hasAttribute("data-lifted")).toBe(false);
	expect(rows.A?.style.transform).toBe("");
	expect(rows.B?.style.transform).toBe("");
	expect(root.hasAttribute("data-reordering")).toBe(false);
	expect(root.querySelector("[data-drop-target]")).toBeNull();
});

test("dragged over another zone it lights that zone and shows a line instead of moving the rows", async () => {
	const { root, rows, folder } = page5();
	const run = start(rows.A as HTMLElement, root, 120);
	pointer("pointermove", 250);
	await frames();
	expect(folder.hasAttribute("data-drop-target")).toBe(true);
	expect(folder.querySelector(".drop-line")).not.toBeNull();
	expect(rows.B?.style.transform).toBe("");
	pointer("pointerup", 250);
	const outcome = run.done[0] as Extract<Outcome, { type: "room" }>;
	expect(outcome.drop.zone.folder).toBe("f1");
	expect(outcome.drop.before).toBe("C");
	expect(folder.querySelector(".drop-line")).toBeNull();
});

test("a finger that lets go without moving is a tap, and Escape or a drop outside every zone cancels", async () => {
	const { root, rows } = page5();
	let run = start(rows.A as HTMLElement, root, 120);
	pointer("pointerup", 121);
	expect(run.done).toEqual([{ type: "tap" }]);

	run = start(rows.A as HTMLElement, root, 120);
	pointer("pointermove", 200);
	await frames();
	window.dispatchEvent(
		new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
	);
	expect(run.done).toEqual([{ type: "cancel" }]);
	expect(rows.A?.hasAttribute("data-lifted")).toBe(false);

	run = start(rows.A as HTMLElement, root, 120);
	pointer("pointermove", 760);
	await frames();
	pointer("pointerup", 760);
	expect(run.done).toEqual([{ type: "cancel" }]);
});

test("a wobble as wide as the hold allows (10 px) is still a tap, a wider move is a drag", async () => {
	const { root, rows } = page5();
	let run = start(rows.A as HTMLElement, root, 120);
	pointer("pointermove", 128);
	await frames();
	pointer("pointerup", 128);
	expect(run.done).toEqual([{ type: "tap" }]);
	run = start(rows.A as HTMLElement, root, 120);
	pointer("pointermove", 134);
	await frames();
	pointer("pointerup", 134);
	expect(run.done[0]?.type).not.toBe("tap");
});

test("a place that waits empty shows once a row is lifted, and is a place to drop", async () => {
	const { root, rows } = page5();
	// An empty pinned list sits above the others, hidden until a row is lifted.
	const empty = el("section", {
		"data-empty": "",
		"data-drop-zone": "pinned",
		"data-zone-id": "pinned",
	});
	root.prepend(empty);
	const visible = () => root.hasAttribute("data-reordering");
	empty.getBoundingClientRect = () =>
		({
			top: 100,
			bottom: visible() ? 144 : 100,
			left: 0,
			right: 300,
			width: 300,
			height: visible() ? 44 : 0,
			x: 0,
			y: 100,
			toJSON: () => ({}),
		}) as DOMRect;
	// Pinned used to be rows A and B; here they are in the rest, so the strip is the only pinned zone.
	for (const zoneEl of root.querySelectorAll("[data-zone-id='pinned']"))
		if (zoneEl !== empty) zoneEl.setAttribute("data-zone-id", "was-pinned");
	const run = start(rows.D as HTMLElement, root, 340);
	pointer("pointermove", 120);
	await frames();
	pointer("pointerup", 120);
	expect(run.done[0]).toMatchObject({
		type: "room",
		drop: { before: null, zone: { kind: "pinned", id: "pinned" } },
	});
});

test("another finger's events are ignored, and stopping early cleans up", async () => {
	const { root, rows } = page5();
	const run = start(rows.A as HTMLElement, root, 120);
	pointer("pointermove", 200, 2);
	pointer("pointerup", 200, 2);
	expect(run.done).toEqual([]);
	run.stop();
	expect(run.done).toEqual([{ type: "cancel" }]);
	expect(root.hasAttribute("data-reordering")).toBe(false);
});

test("a folded folder opens after the finger rests on it, and the list is measured again", async () => {
	const { root, rows, folder } = page5();
	folder.setAttribute("data-collapsed", "");
	// A folded folder's rows, if any are in the document, are hidden: they are not places to drop between.
	expect(rows.C?.isConnected).toBe(true);
	const run = start(rows.A as HTMLElement, root, 120);
	pointer("pointermove", 260);
	await frames();
	expect(run.opened).toEqual([]);
	await new Promise((resolve) => setTimeout(resolve, 700));
	expect(run.opened).toEqual(["f1"]);
	run.stop();
});

test("a folder dragged by its header moves among the folder blocks", async () => {
	const block = (key: string) =>
		el(
			"section",
			{ "data-folder-block": "", "data-key": key },
			el("header", { "data-folder-head": "" }),
		);
	const blocks = [block("f1"), block("f2"), block("f3")];
	const list = el("div", { "data-folder-list": "" }, ...blocks);
	document.body.append(list);
	box(list, 100, 300);
	blocks.forEach((one, i) => {
		box(one, 100 + i * 100, 88);
		const head = one.querySelector("[data-folder-head]");
		if (head) box(head, 100 + i * 100, 44);
	});
	const done: Outcome[] = [];
	lift({
		mode: "folder",
		item: blocks[0] as HTMLElement,
		key: "f1",
		pointerId: 1,
		y: 120,
		root: list,
		open: () => undefined,
		done: (outcome) => done.push(outcome),
	});
	pointer("pointermove", 240);
	await frames();
	expect(blocks[1]?.style.transform).toBe("translate3d(0, -100px, 0)");
	pointer("pointerup", 240);
	expect(done).toEqual([{ type: "folder", before: "f3" }]);
	expect(blocks[1]?.style.transform).toBe("");
});
