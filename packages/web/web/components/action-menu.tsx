import {
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	closeMenu,
	type MenuItem,
	type OpenMenu,
	useOpenMenu,
} from "../lib/action-menu.ts";
import { Icon } from "./icons.tsx";
import { Sheet } from "./sheet.tsx";

/** Under this width the menu is a sheet from the bottom edge; keep in step with the sheet's own query. */
const compact = (): boolean =>
	typeof matchMedia === "function" && matchMedia("(max-width: 719px)").matches;

/** The history entry the open sheet stands on, so the system Back closes it before it leaves the page. */
const ENTRY = { rtMenu: true };
const onEntry = (): boolean =>
	Boolean((window.history.state as { rtMenu?: boolean } | null)?.rtMenu);

/** The margin the popover keeps from the window's edge. */
const EDGE = 8;

/** A focus target that can still take focus. */
const live = (element: HTMLElement | null): HTMLElement | null =>
	element?.isConnected ? element : null;

/** The menu's buttons: each action is a menu item, and a toggle is a checkbox item. */
function Items(props: {
	items: readonly MenuItem[];
	onChoose(item: MenuItem): void;
}) {
	return props.items.map((item) => (
		<button
			key={item.id}
			type="button"
			role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
			{...(item.checked === undefined ? {} : { "aria-checked": item.checked })}
			className="menu-item menu-link"
			data-tone={item.tone}
			onClick={() => props.onChoose(item)}
		>
			{item.icon ? (
				<span className="menu-icon" data-tone={item.tone}>
					<Icon name={item.icon} size={18} />
				</span>
			) : null}
			<span className="menu-text">
				<strong>{item.label}</strong>
			</span>
			{item.checked ? (
				<Icon name="check" size={18} className="menu-check" />
			) : null}
		</button>
	));
}

/** The phone's form: a sheet that Back, Escape, a tap outside and a drag down all close. */
function SheetMenu({ menu }: { menu: OpenMenu | undefined }) {
	const last = useRef<OpenMenu | undefined>(undefined);
	if (menu) last.current = menu;
	const shown = last.current;
	const pushed = useRef(false);
	const after = useRef<(() => void | Promise<void>) | undefined>(undefined);
	const serial = menu?.serial;

	// The sheet stands on a history entry of its own; stepping off it, however that happens, closes it.
	useEffect(() => {
		if (serial === undefined) return;
		window.history.pushState(ENTRY, "", window.location.href);
		pushed.current = true;
		return () => {
			// Closed from inside (an X, a drag, Escape): the entry is still there.
			if (pushed.current) {
				pushed.current = false;
				window.history.back();
			}
		};
	}, [serial]);

	useEffect(() => {
		const onPop = () => {
			if (!pushed.current || onEntry()) return;
			pushed.current = false;
			closeMenu();
			const run = after.current;
			after.current = undefined;
			void run?.();
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	return (
		<Sheet
			open={menu !== undefined}
			title={shown?.title ?? ""}
			onClose={closeMenu}
			restoreFocus={() => live(shown?.source ?? null)}
		>
			{shown ? (
				<div className="menu action-items" role="menu" aria-label={shown.title}>
					<Items
						items={shown.items}
						onChoose={(item) => {
							if (!pushed.current) {
								closeMenu();
								void item.run();
								return;
							}
							after.current = item.run;
							window.history.back();
						}}
					/>
				</div>
			) : null}
		</Sheet>
	);
}

/** The desktop's form: a menu at the pointer, with arrow keys, a Tab that stays inside, and Escape. */
function PopoverMenu({ menu }: { menu: OpenMenu }) {
	const root = useRef<HTMLDivElement>(null);
	const [place, setPlace] = useState(menu.at);
	const { source } = menu;

	const leave = (then?: () => void | Promise<void>) => {
		live(source)?.focus();
		closeMenu();
		void then?.();
	};
	const leaveRef = useRef(leave);
	leaveRef.current = leave;

	// Keeps the popover inside the window, then takes focus.
	// biome-ignore lint/correctness/useExhaustiveDependencies: placed once per menu, from where it was asked
	useLayoutEffect(() => {
		const element = root.current;
		if (!element) return;
		// A fixed box asked for near the window's right edge is squeezed to the room left of it, and its
		// entrance animation scales it, so it is measured from the left edge by its layout size and
		// only then put where it fits.
		const asked = { left: element.style.left, top: element.style.top };
		element.style.left = "0px";
		element.style.top = "0px";
		const box = { width: element.offsetWidth, height: element.offsetHeight };
		element.style.left = asked.left;
		element.style.top = asked.top;
		setPlace({
			x: Math.max(
				EDGE,
				Math.min(menu.at.x, window.innerWidth - box.width - EDGE),
			),
			y: Math.max(
				EDGE,
				Math.min(menu.at.y, window.innerHeight - box.height - EDGE),
			),
		});
		element.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
	}, [menu.serial]);

	// A press anywhere else, the person's own scrolling or a resize puts the menu away; the list
	// moving by itself (a new message, a stream) does not.
	useEffect(() => {
		const away = (event: Event) => {
			if (event.target instanceof Node && root.current?.contains(event.target))
				return;
			closeMenu();
		};
		const gone = () => closeMenu();
		document.addEventListener("pointerdown", away, true);
		document.addEventListener("wheel", away, { capture: true, passive: true });
		document.addEventListener("touchmove", away, {
			capture: true,
			passive: true,
		});
		window.addEventListener("resize", gone);
		return () => {
			document.removeEventListener("pointerdown", away, true);
			document.removeEventListener("wheel", away, true);
			document.removeEventListener("touchmove", away, true);
			window.removeEventListener("resize", gone);
		};
	}, []);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const buttons = [
			...(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ??
				[]),
		];
		const at = buttons.indexOf(document.activeElement as HTMLElement);
		const go = (to: number) => {
			event.preventDefault();
			buttons[(to + buttons.length) % buttons.length]?.focus();
		};
		switch (event.key) {
			case "Escape":
				event.preventDefault();
				event.stopPropagation();
				leaveRef.current();
				return;
			case "ArrowDown":
				return go(at + 1);
			case "ArrowUp":
				return go(at < 0 ? -1 : at - 1);
			case "Tab":
				return go(event.shiftKey ? (at < 0 ? -1 : at - 1) : at + 1);
			case "Home":
				return go(0);
			case "End":
				return go(-1);
		}
	};

	return (
		<div
			ref={root}
			className="action-popover"
			role="menu"
			aria-label={menu.title}
			tabIndex={-1}
			style={{ left: `${place.x}px`, top: `${place.y}px` }}
			onKeyDown={onKeyDown}
		>
			<Items items={menu.items} onChoose={(item) => leave(item.run)} />
		</div>
	);
}

/** Draws the page's one action menu: a sheet on a phone, a popover at the pointer elsewhere. */
export function ActionMenuHost() {
	const menu = useOpenMenu();
	const decided = useRef<{ serial: number; sheet: boolean } | undefined>(
		undefined,
	);
	if (menu && decided.current?.serial !== menu.serial)
		decided.current = { serial: menu.serial, sheet: compact() };
	const sheet = Boolean(menu && decided.current?.sheet);
	return (
		<>
			<SheetMenu menu={sheet ? menu : undefined} />
			{menu && !sheet ? <PopoverMenu key={menu.serial} menu={menu} /> : null}
		</>
	);
}
