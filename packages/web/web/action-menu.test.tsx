import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "bun:test";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu, type MenuItem, openMenu } from "./lib/action-menu.ts";
import { loadKit } from "./lib/kit.ts";
import { HOLD_MS, type PressRequest, useLongPress } from "./lib/long-press.ts";
import { setRouting } from "./lib/router.ts";

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

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const presses: PressRequest[] = [];
let swallowedClicks = 0;

function Target(props: { selectable?: boolean }) {
	const press = useLongPress((request) => presses.push(request), {
		selectable: props.selectable ?? false,
	});
	return (
		<div>
			<button
				type="button"
				id="row"
				{...press}
				onClick={() => {
					swallowedClicks += 1;
				}}
			>
				row
			</button>
			<input id="field" {...press} />
		</div>
	);
}

beforeEach(() => {
	presses.length = 0;
	swallowedClicks = 0;
	window.innerWidth = 390;
});
afterEach(async () => {
	await page.act(() => closeMenu());
	await page.render(null);
	Reflect.deleteProperty(navigator, "vibrate");
});

const element = (id: string): HTMLElement => {
	const found = document.getElementById(id);
	if (!found) throw new Error(`no #${id}`);
	return found;
};

function pointer(
	target: Element,
	type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
	x: number,
	y: number,
	kind: "touch" | "mouse" | "pen" = "touch",
): void {
	target.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			clientX: x,
			clientY: y,
			pointerId: 1,
			pointerType: kind,
			isPrimary: true,
		}),
	);
}

test("a touch that rests 450 ms opens the menu once at the finger, and ticks on a phone that can", async () => {
	const ticks: number[] = [];
	Object.defineProperty(navigator, "vibrate", {
		value: (ms: number) => ticks.push(ms),
		configurable: true,
	});
	await page.render(<Target />);
	await page.act(() => pointer(element("row"), "pointerdown", 30, 40));
	await settle(HOLD_MS - 150);
	expect(presses).toEqual([]);
	await settle(250);
	expect(presses.length).toBe(1);
	expect(presses[0]?.via).toBe("hold");
	expect(presses[0]?.at).toEqual({ x: 30, y: 40 });
	expect(presses[0]?.source).toBe(element("row"));
	expect(ticks).toEqual([10]);
	await page.act(() => pointer(element("row"), "pointerup", 30, 40));
	await settle(HOLD_MS + 50);
	expect(presses.length).toBe(1);
});

test("a phone without vibrate still opens the menu", async () => {
	await page.render(<Target />);
	await page.act(() => pointer(element("row"), "pointerdown", 1, 1));
	await settle(HOLD_MS + 60);
	expect(presses.length).toBe(1);
});

test("lifting early is a tap, a move over 10 px or a scroll cancels the hold, and a small wobble does not", async () => {
	await page.render(<Target />);
	await page.act(() => {
		pointer(element("row"), "pointerdown", 30, 40);
		pointer(element("row"), "pointerup", 30, 40);
	});
	await settle(HOLD_MS + 60);
	expect(presses).toEqual([]);

	await page.act(() => {
		pointer(element("row"), "pointerdown", 30, 40);
		pointer(element("row"), "pointermove", 30, 52);
	});
	await settle(HOLD_MS + 60);
	expect(presses).toEqual([]);

	await page.act(() => {
		pointer(element("row"), "pointerdown", 30, 40);
		window.dispatchEvent(new Event("scroll"));
	});
	await settle(HOLD_MS + 60);
	expect(presses).toEqual([]);

	await page.act(() => {
		pointer(element("row"), "pointerdown", 30, 40);
		pointer(element("row"), "pointermove", 34, 46);
	});
	await settle(HOLD_MS + 60);
	expect(presses.length).toBe(1);
});

test("a mouse button held down does not open the menu, and a field's own touch is left alone", async () => {
	await page.render(<Target />);
	await page.act(() => pointer(element("row"), "pointerdown", 30, 40, "mouse"));
	await settle(HOLD_MS + 60);
	expect(presses).toEqual([]);
	await page.act(() => pointer(element("field"), "pointerdown", 30, 40));
	await settle(HOLD_MS + 60);
	expect(presses).toEqual([]);
});

test("the click that ends a hold does not follow the row's link; the next tap does", async () => {
	await page.render(<Target />);
	await page.act(() => pointer(element("row"), "pointerdown", 30, 40));
	await settle(HOLD_MS + 60);
	await page.act(() => {
		pointer(element("row"), "pointerup", 30, 40);
		element("row").click();
	});
	expect(swallowedClicks).toBe(0);
	await page.act(() => {
		pointer(element("row"), "pointerdown", 30, 40);
		pointer(element("row"), "pointerup", 30, 40);
		element("row").click();
	});
	expect(swallowedClicks).toBe(1);
});

test("a right click opens the menu at the pointer and keeps the browser's own menu away", async () => {
	await page.render(<Target />);
	const event = new MouseEvent("contextmenu", {
		bubbles: true,
		cancelable: true,
		clientX: 210,
		clientY: 95,
	});
	await page.act(() => {
		element("row").dispatchEvent(event);
	});
	expect(event.defaultPrevented).toBe(true);
	expect(presses.length).toBe(1);
	expect(presses[0]?.via).toBe("contextmenu");
	expect(presses[0]?.at).toEqual({ x: 210, y: 95 });
});

test("Android's contextmenu after the hold that opened the menu does not open it twice", async () => {
	await page.render(<Target />);
	await page.act(() => pointer(element("row"), "pointerdown", 30, 40));
	await settle(HOLD_MS + 60);
	const event = new MouseEvent("contextmenu", {
		bubbles: true,
		cancelable: true,
		clientX: 30,
		clientY: 40,
	});
	await page.act(() => {
		element("row").dispatchEvent(event);
	});
	expect(event.defaultPrevented).toBe(true);
	expect(presses.length).toBe(1);
});

test("the Menu key and Shift+F10 open it from the keyboard; other keys do not", async () => {
	await page.render(<Target />);
	const key = (init: KeyboardEventInit) =>
		new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
	const menuKey = key({ key: "ContextMenu" });
	await page.act(() => {
		element("row").dispatchEvent(menuKey);
	});
	expect(menuKey.defaultPrevented).toBe(true);
	expect(presses.length).toBe(1);
	expect(presses[0]?.via).toBe("key");
	await page.act(() => {
		element("row").dispatchEvent(key({ key: "F10", shiftKey: true }));
	});
	expect(presses.length).toBe(2);
	await page.act(() => {
		element("row").dispatchEvent(key({ key: "F10" }));
		element("row").dispatchEvent(key({ key: "Enter" }));
	});
	expect(presses.length).toBe(2);
});

test("the innermost target with a menu answers; its container does not open a second one", async () => {
	function Nested() {
		const outer = useLongPress((request) => presses.push(request));
		const inner = useLongPress((request) => presses.push(request));
		return (
			<div id="outer" {...outer}>
				<span id="inner" {...inner}>
					x
				</span>
			</div>
		);
	}
	await page.render(<Nested />);
	await page.act(() => {
		element("inner").dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
		);
	});
	expect(presses.length).toBe(1);
	expect(presses[0]?.source).toBe(element("inner"));
});

// ── The menu ─────────────────────────────────────────────────────────────────────────────────

const ran: string[] = [];
const items = (): MenuItem[] => [
	{ id: "one", label: "First", icon: "copy", run: () => void ran.push("one") },
	{
		id: "two",
		label: "Second",
		icon: "bolt",
		checked: true,
		run: () => void ran.push("two"),
	},
	{
		id: "three",
		label: "Third",
		tone: "danger",
		run: () => void ran.push("three"),
	},
];

const sheet = () => document.querySelector<HTMLDialogElement>("dialog.sheet");
const popover = () => document.querySelector<HTMLElement>(".action-popover");
const menuItems = (): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
];
const choose = (label: string) =>
	page.click(
		menuItems().find((one) => one.textContent?.includes(label)) ?? null,
	);

function openAt(x: number, y: number, via: PressRequest["via"] = "hold") {
	ran.length = 0;
	return page.act(() =>
		openMenu({
			title: "Menu title",
			items: items(),
			at: { x, y },
			via,
			source: document.body,
		}),
	);
}

test("on a phone width the menu is a bottom sheet, with each action a menu item and a toggle checked", async () => {
	window.innerWidth = 390;
	await page.render(<ActionMenuHost />);
	await openAt(200, 300);
	expect(sheet()?.open).toBe(true);
	expect(popover()).toBeNull();
	expect(menuItems().map((one) => one.textContent)).toEqual([
		"First",
		"Second",
		"Third",
	]);
	expect(menuItems()[1]?.getAttribute("role")).toBe("menuitemcheckbox");
	expect(menuItems()[1]?.getAttribute("aria-checked")).toBe("true");
	expect(menuItems()[0]?.getAttribute("role")).toBe("menuitem");
	expect(sheet()?.getAttribute("aria-label")).toBe("Menu title");
});

test("on a desktop width it is a popover at the pointer, kept inside the window", async () => {
	window.innerWidth = 1280;
	window.innerHeight = 800;
	await page.render(<ActionMenuHost />);
	await openAt(300, 200);
	expect(popover()).not.toBeNull();
	expect(sheet()?.open ?? false).toBe(false);
	expect(popover()?.getAttribute("role")).toBe("menu");
	expect(popover()?.style.left).toBe("300px");
	expect(popover()?.style.top).toBe("200px");
	await page.act(() => closeMenu());
	await openAt(1279, 799);
	const left = Number.parseInt(popover()?.style.left ?? "", 10);
	const top = Number.parseInt(popover()?.style.top ?? "", 10);
	expect(left).toBeLessThan(1279);
	expect(top).toBeLessThan(799);
});

test("choosing an item closes the menu and then runs it, once", async () => {
	window.innerWidth = 1280;
	await page.render(<ActionMenuHost />);
	await openAt(300, 200);
	await choose("Third");
	await settle(60);
	expect(ran).toEqual(["three"]);
	expect(popover()).toBeNull();
});

test("on a phone choosing an item steps back off the menu's history entry, then runs it", async () => {
	window.innerWidth = 390;
	await page.render(<ActionMenuHost />);
	await openAt(200, 300);
	expect(history.state).toEqual({ rtMenu: true });
	await choose("First");
	await settle(80);
	expect(ran).toEqual(["one"]);
	expect(history.state).toBeNull();
	await settle(300);
	expect(sheet()?.open ?? false).toBe(false);
});

test("the system Back closes the sheet and runs nothing", async () => {
	window.innerWidth = 390;
	await page.render(<ActionMenuHost />);
	await openAt(200, 300);
	expect(sheet()?.open).toBe(true);
	await page.act(() => history.back());
	await settle(300);
	expect(sheet()?.open ?? false).toBe(false);
	expect(ran).toEqual([]);
});

test("Escape closes the sheet, and the popover too, and gives focus back to where the press began", async () => {
	window.innerWidth = 390;
	await page.render(
		<>
			<button type="button" id="origin">
				origin
			</button>
			<ActionMenuHost />
		</>,
	);
	const origin = element("origin");
	origin.focus();
	await page.act(() =>
		openMenu({
			title: "T",
			items: items(),
			at: { x: 1, y: 1 },
			via: "key",
			source: origin,
		}),
	);
	await page.act(() => {
		sheet()?.dispatchEvent(new Event("cancel", { cancelable: true }));
	});
	await settle(300);
	expect(sheet()?.open ?? false).toBe(false);
	expect(document.activeElement).toBe(origin);

	window.innerWidth = 1280;
	await page.act(() =>
		openMenu({
			title: "T",
			items: items(),
			at: { x: 1, y: 1 },
			via: "key",
			source: origin,
		}),
	);
	await page.act(() => {
		popover()?.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			}),
		);
	});
	expect(popover()).toBeNull();
	expect(document.activeElement).toBe(origin);
});

test("the popover takes focus, moves it with the arrow keys, and keeps Tab inside", async () => {
	window.innerWidth = 1280;
	await page.render(<ActionMenuHost />);
	await openAt(300, 200, "key");
	const [first = null, second = null, third = null] = menuItems();
	expect(document.activeElement).toBe(first);
	const key = (init: KeyboardEventInit) =>
		page.act(() => {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", {
					bubbles: true,
					cancelable: true,
					...init,
				}),
			);
		});
	await key({ key: "ArrowDown" });
	expect(document.activeElement).toBe(second);
	await key({ key: "End" });
	expect(document.activeElement).toBe(third);
	await key({ key: "Tab" });
	expect(document.activeElement).toBe(first);
	await key({ key: "Tab", shiftKey: true });
	expect(document.activeElement).toBe(third);
	await key({ key: "ArrowDown" });
	expect(document.activeElement).toBe(first);
	await key({ key: "ArrowUp" });
	expect(document.activeElement).toBe(third);
	await key({ key: "Home" });
	expect(document.activeElement).toBe(first);
});

test("a press outside the popover closes it", async () => {
	window.innerWidth = 1280;
	await page.render(
		<>
			<button type="button" id="elsewhere">
				elsewhere
			</button>
			<ActionMenuHost />
		</>,
	);
	await openAt(300, 200);
	expect(popover()).not.toBeNull();
	await page.act(() => {
		element("elsewhere").dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
		);
	});
	expect(popover()).toBeNull();
	expect(ran).toEqual([]);
});

test("the person's own scroll closes the popover, and the list moving by itself does not", async () => {
	window.innerWidth = 1280;
	await page.render(
		<>
			<div id="list">list</div>
			<ActionMenuHost />
		</>,
	);
	await openAt(300, 200);
	await page.act(() => {
		window.dispatchEvent(new Event("scroll"));
		element("list").dispatchEvent(new Event("scroll"));
	});
	expect(popover()).not.toBeNull();
	await page.act(() => {
		element("list").dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
	});
	expect(popover()).toBeNull();
});

test("a menu with no items does not open", async () => {
	window.innerWidth = 1280;
	await page.render(<ActionMenuHost />);
	await page.act(() =>
		openMenu({
			title: "Empty",
			items: [],
			at: { x: 1, y: 1 },
			via: "hold",
			source: null,
		}),
	);
	expect(popover()).toBeNull();
	expect(sheet()?.open ?? false).toBe(false);
});
