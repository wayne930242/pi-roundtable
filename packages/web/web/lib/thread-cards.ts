// What a dispatch thread's card does under a finger, a mouse and the keyboard: a finished card swipes
// right to clear itself, a hold or a right click opens its menu, and Delete clears it. The list of
// cards loads this once there is one, and hands it the element that holds them all.

import { type MenuItem, openMenu } from "./action-menu.ts";
import type { Point, Via } from "./long-press.ts";
import { translate as t } from "./messages.ts";
import { reducedMotion } from "./motion.ts";
import { attachRowSwipe } from "./row-swipe.ts";
import { clearFinished, dismissThread } from "./thread-actions.ts";

const SLIDE_MS = 180;
const COLLAPSE_MS = 150;

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

/**
 * Gives `root`, the element that holds a list's cards, their gestures. Returns what takes them off
 * again. A card that is finished follows a finger to the right and goes when it is let go past 40 %
 * of its width, or flicked; one that is open only gives a little and comes back.
 */
export function attachThreadCards(root: HTMLElement): () => void {
	const swipe = attachRowSwipe(root, {
		row: CARD,
		// The menu button is a button, not a card.
		ignore: ".thread-more",
		can: isFinished,
		act: (card) => void leave(card),
		leaves: true,
		busy: (card) => card.dataset.leaving !== undefined,
		hold: (card, at) => openCardMenu(card, at, "hold"),
	});

	const onContextMenu = (event: MouseEvent) => {
		const card = cardOf(event.target);
		if (!card) return;
		event.preventDefault();
		// Android reports its long press as this event, after the hold that already opened the menu.
		if (swipe.swallowing) return;
		swipe.cancelHold();
		openCardMenu(card, { x: event.clientX, y: event.clientY }, "contextmenu");
	};

	const onKey = (event: KeyboardEvent) => {
		swipe.forget();
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

	root.addEventListener("contextmenu", onContextMenu);
	root.addEventListener("keydown", onKey);
	return () => {
		swipe.detach();
		root.removeEventListener("contextmenu", onContextMenu);
		root.removeEventListener("keydown", onKey);
	};
}
