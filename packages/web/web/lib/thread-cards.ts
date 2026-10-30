// What a dispatch thread's card does under a finger, a mouse and the keyboard: a finished card swipes
// right to clear itself, a hold or a right click opens its menu, and Delete clears it. The list of
// cards loads this once there is one, and hands it the element that holds them all.

import { type MenuItem, openMenu } from "./action-menu.ts";
import { LongPress, type Point, type Via } from "./long-press.ts";
import { translate as t } from "./messages.ts";
import { reducedMotion } from "./motion.ts";
import { armTouches } from "./row-press.ts";
import { AXIS_RATIO, atScreenEdge, settles } from "./swipe.ts";
import { clearFinished, dismissThread } from "./thread-actions.ts";

/** How far (px) the finger goes sideways before the swipe is told from a scroll or a tap. */
const INTENT = 12;
/** The most (px) an open card gives to a finger that pulls it, before it pulls back. */
const RUBBER_MAX = 24;
const SLIDE_MS = 180;
const COLLAPSE_MS = 150;
/** The last stretch of the drag (ms) that the finger's speed is read from. */
const SPEED_WINDOW_MS = 100;

const CARD = ".thread-card";
const GROUP = ".thread-group";

const cardOf = (target: EventTarget | null): HTMLElement | null =>
	target instanceof Element ? target.closest<HTMLElement>(CARD) : null;

const itemOf = (card: HTMLElement): HTMLElement | null => card.closest("li");

const isFinished = (card: HTMLElement): boolean => card.dataset.closed === "";

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The finished cards of the list `card` is in, by thread key. */
function finishedIn(card: HTMLElement): string[] {
	const group = card.closest<HTMLElement>(GROUP);
	return [
		...(group?.querySelectorAll<HTMLElement>(`${CARD}[data-closed]`) ?? []),
	].flatMap((one) => (one.dataset.thread ? [one.dataset.thread] : []));
}

/** Shows the card where it belongs again, as it was before it set out to leave. */
function bringBack(card: HTMLElement): void {
	const item = itemOf(card);
	delete card.dataset.armed;
	card.style.transition = "";
	card.style.transform = "";
	card.style.opacity = "";
	if (item) {
		item.style.transition = "";
		item.style.height = "";
		item.style.marginBottom = "";
		item.style.opacity = "";
	}
}

/** The card slides out to the right and the list closes the gap; nothing moves for someone who asked for less motion. */
async function slideOut(card: HTMLElement): Promise<void> {
	const item = itemOf(card);
	if (!item || reducedMotion()) return;
	card.dataset.leaving = "";
	card.style.transition = `transform ${SLIDE_MS}ms var(--ease-out), opacity ${SLIDE_MS}ms var(--ease-out)`;
	card.style.transform = "translate3d(110%, 0, 0)";
	card.style.opacity = "0";
	await wait(SLIDE_MS);
	item.style.height = `${item.offsetHeight}px`;
	// Reading the height above and setting it here must not collapse into one style change.
	item.getBoundingClientRect();
	item.style.transition = `height ${COLLAPSE_MS}ms var(--ease-out), margin-bottom ${COLLAPSE_MS}ms var(--ease-out)`;
	item.style.height = "0px";
	item.style.marginBottom = "calc(var(--space-1) * -1)";
	await wait(COLLAPSE_MS);
}

/** Moves focus to the card beside this one, so the keyboard stays in the list when the card goes. */
function focusBeside(card: HTMLElement): void {
	const links = [
		...(card
			.closest<HTMLElement>(GROUP)
			?.querySelectorAll<HTMLElement>(`${CARD} .thread-link`) ?? []),
	];
	const own = card.querySelector<HTMLElement>(".thread-link");
	const at = own ? links.indexOf(own) : -1;
	if (document.activeElement && !card.contains(document.activeElement)) return;
	(
		links[at + 1] ??
		links[at - 1] ??
		card.closest(GROUP)?.querySelector("summary")
	)
		?.closest<HTMLElement>("a, summary")
		?.focus();
}

/** Clears a finished card: it leaves, the server is told, and if it refuses the card comes back. */
export async function leave(card: HTMLElement): Promise<void> {
	const key = card.dataset.thread;
	if (!key || !isFinished(card) || card.dataset.leaving !== undefined) return;
	focusBeside(card);
	await slideOut(card);
	if (!(await dismissThread(key))) bringBack(card);
	delete card.dataset.leaving;
}

/** Opens the card's menu: clearing this finished thread, and clearing all the finished ones of its list. */
export function openCardMenu(card: HTMLElement, at: Point, via: Via): void {
	const items: MenuItem[] = [];
	if (isFinished(card))
		items.push({
			id: "clear",
			label: t("Clear this thread"),
			icon: "trash",
			tone: "danger",
			run: () => leave(card),
		});
	const finished = finishedIn(card);
	const parent = card.closest<HTMLElement>(GROUP)?.dataset.parent || undefined;
	if (finished.length > 0)
		items.push({
			id: "clear-all",
			label: t("Clear all finished"),
			icon: "trash",
			tone: "danger",
			run: () => clearFinished(parent, finished),
		});
	openMenu({
		title: card.querySelector(".thread-title")?.textContent ?? "",
		items,
		at,
		via,
		source: card.querySelector<HTMLElement>(".thread-link") ?? card,
	});
}

/** One finger on a card, from its touch to its lift. */
interface Finger {
	id: number;
	card: HTMLElement;
	origin: Point;
	press: LongPress;
	/** Where the finger is judged: a swipe from a screen edge belongs to the system. */
	swipes: boolean;
	state: "wait" | "drag" | "reject";
	offset: number;
	samples: { x: number; t: number }[];
}

const keepScroll = (event: TouchEvent) => {
	if (event.cancelable) event.preventDefault();
};

/** How fast (px per ms) the finger was going to the right when it lifted at `at`. */
function speedOf(samples: Finger["samples"], at: number): number {
	const last = samples.at(-1);
	if (!last || at - last.t > SPEED_WINDOW_MS) return 0;
	const first = samples.find((one) => last.t - one.t <= SPEED_WINDOW_MS);
	if (!first || last.t <= first.t) return 0;
	return (last.x - first.x) / (last.t - first.t);
}

/**
 * Gives `root`, the element that holds a list's cards, their gestures. Returns what takes them off
 * again. A card that is finished follows a finger to the right and goes when it is let go past 40 %
 * of its width, or flicked; one that is open only gives a little and comes back.
 */
export function attachThreadCards(root: HTMLElement): () => void {
	const disarm = armTouches();
	let finger: Finger | undefined;
	/** A swipe or a hold happened: the click that follows the lift must not open the card. */
	let swallow = false;

	const end = () => {
		finger?.press.cancel();
		window.removeEventListener("touchmove", keepScroll);
		finger = undefined;
	};

	const onDown = (event: PointerEvent) => {
		swallow = false;
		if (event.pointerType === "mouse" || !event.isPrimary) return;
		const card = cardOf(event.target);
		// The menu button is a button, not a card.
		if (!card || (event.target as Element).closest(".thread-more")) return;
		end();
		const origin = { x: event.clientX, y: event.clientY };
		const press = new LongPress((at) => {
			swallow = true;
			if (typeof navigator.vibrate === "function") navigator.vibrate(10);
			if (finger) finger.state = "reject";
			resetPull(card);
			openCardMenu(card, at, "hold");
		});
		press.begin(origin.x, origin.y);
		finger = {
			id: event.pointerId,
			card,
			origin,
			press,
			swipes: !atScreenEdge(origin.x, window.innerWidth),
			state: "wait",
			offset: 0,
			samples: [{ x: origin.x, t: event.timeStamp }],
		};
	};

	/** The card back at rest under a finger that is no longer pulling it. */
	const resetPull = (card: HTMLElement) => {
		if (card.dataset.leaving !== undefined) return;
		delete card.dataset.armed;
		card.style.transition = `transform ${reducedMotion() ? 0 : SLIDE_MS}ms var(--ease-out)`;
		card.style.transform = "";
	};

	const onMove = (event: PointerEvent) => {
		if (!finger || finger.id !== event.pointerId) return;
		const { card } = finger;
		const dx = event.clientX - finger.origin.x;
		const dy = event.clientY - finger.origin.y;
		if (finger.state === "wait") {
			// A finger that wanders off the hold gives it up by itself.
			finger.press.move(event.clientX, event.clientY);
			const across = Math.abs(dx);
			if (!finger.swipes) return;
			if (across >= INTENT && across > AXIS_RATIO * Math.abs(dy)) {
				// The card follows a finger going right; one going left is not ours.
				finger.state = dx > 0 ? "drag" : "reject";
				if (finger.state === "drag") {
					finger.press.cancel();
					card.style.transition = "none";
					window.addEventListener("touchmove", keepScroll, {
						passive: false,
					});
				}
			} else if (Math.abs(dy) >= INTENT) finger.state = "reject";
			if (finger.state !== "drag") return;
		}
		if (finger.state !== "drag") return;
		const pulled = Math.max(0, dx - INTENT);
		const width = card.offsetWidth || 1;
		finger.offset = isFinished(card)
			? Math.min(pulled, width)
			: Math.min(RUBBER_MAX, pulled * 0.3);
		finger.samples.push({ x: event.clientX, t: event.timeStamp });
		card.style.transform = `translate3d(${finger.offset}px, 0, 0)`;
		if (isFinished(card)) {
			if (settles(finger.offset / width, 0)) card.dataset.armed = "";
			else delete card.dataset.armed;
		}
	};

	const onUp = (event: PointerEvent) => {
		if (!finger || finger.id !== event.pointerId) return;
		const { card, state, offset, samples } = finger;
		const fired = finger.press.end();
		end();
		if (fired) swallow = true;
		if (state !== "drag") return;
		swallow = true;
		const width = card.offsetWidth || 1;
		const velocity = speedOf(samples, event.timeStamp);
		if (
			isFinished(card) &&
			offset > INTENT &&
			settles(offset / width, velocity)
		)
			void leave(card);
		else resetPull(card);
	};

	const onCancel = (event: PointerEvent) => {
		if (!finger || finger.id !== event.pointerId) return;
		const { card, state } = finger;
		end();
		if (state === "drag") resetPull(card);
	};

	const onContextMenu = (event: MouseEvent) => {
		const card = cardOf(event.target);
		if (!card) return;
		event.preventDefault();
		// Android reports its long press as this event, after the hold that already opened the menu.
		if (swallow) return;
		finger?.press.cancel();
		openCardMenu(card, { x: event.clientX, y: event.clientY }, "contextmenu");
	};

	const onKey = (event: KeyboardEvent) => {
		swallow = false;
		const card = cardOf(event.target);
		if (!card) return;
		if (event.key === "Delete" && isFinished(card)) {
			event.preventDefault();
			void leave(card);
		} else if (
			event.key === "ContextMenu" ||
			(event.key === "F10" && event.shiftKey)
		) {
			event.preventDefault();
			const box = card.getBoundingClientRect();
			openCardMenu(
				card,
				{ x: box.left + Math.min(box.width / 2, 48), y: box.top + 24 },
				"key",
			);
		}
	};

	const onClick = (event: MouseEvent) => {
		if (!swallow) return;
		swallow = false;
		event.preventDefault();
		event.stopPropagation();
	};

	// A link is dragged by the browser as an address; the swipe is ours.
	const onDragStart = (event: DragEvent) => {
		if (cardOf(event.target)) event.preventDefault();
	};

	root.addEventListener("pointerdown", onDown);
	root.addEventListener("pointermove", onMove);
	root.addEventListener("pointerup", onUp);
	root.addEventListener("pointercancel", onCancel);
	root.addEventListener("contextmenu", onContextMenu);
	root.addEventListener("keydown", onKey);
	root.addEventListener("click", onClick, true);
	root.addEventListener("dragstart", onDragStart);
	return () => {
		end();
		disarm();
		root.removeEventListener("pointerdown", onDown);
		root.removeEventListener("pointermove", onMove);
		root.removeEventListener("pointerup", onUp);
		root.removeEventListener("pointercancel", onCancel);
		root.removeEventListener("contextmenu", onContextMenu);
		root.removeEventListener("keydown", onKey);
		root.removeEventListener("click", onClick, true);
		root.removeEventListener("dragstart", onDragStart);
	};
}
