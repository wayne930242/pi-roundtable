// The keyboard shortcuts of the app, as one lazy part the page starts after it has drawn:
// Alt+↑ / Alt+↓ step through the rooms in the order the list shows them, Alt+Shift+↑ / Alt+Shift+↓
// through the rooms with unread messages, `?` lists the keys, and Esc closes the topmost menu or
// sheet, else lets go of the message box. The search key (Ctrl/⌘ K) is in `search-key.ts`.
//
// A key meant for a text field stays the field's: nothing here acts while an input method composes,
// and in a field Alt+↑ / Alt+↓ (a paragraph move on a Mac) act only when the field is empty or the
// caret rests at its very start (↑) or very end (↓) with nothing selected.

import { closeMenu } from "./action-menu.ts";
import { store } from "./app-store.ts";
import { collapsedNow } from "./folds.ts";
import { unreadOf } from "./host-state.ts";
import { composingKey } from "./ime.ts";
import { neighbour, roomStops, type Stop } from "./room-order.ts";
import { activityAt } from "./rooms.ts";
import { currentRoute, hrefFor, navigate } from "./router.ts";
import {
	closeShortcutHelp,
	openShortcutHelp,
	shortcutHelpOpen,
} from "./shortcut-help.ts";

export type Shortcut =
	| "previous"
	| "next"
	| "previous-unread"
	| "next-unread"
	| "help"
	| "escape";

const TEXT_INPUTS = new Set([
	"",
	"text",
	"search",
	"url",
	"tel",
	"email",
	"password",
	"number",
	"date",
	"datetime-local",
	"month",
	"time",
	"week",
]);

/** The element a person types into: a text field, a select, or editable content. */
function editable(target: EventTarget | null): HTMLElement | undefined {
	if (!(target instanceof HTMLElement)) return undefined;
	if (target instanceof HTMLTextAreaElement) return target;
	if (target instanceof HTMLSelectElement) return target;
	if (target instanceof HTMLInputElement)
		return TEXT_INPUTS.has(target.type) ? target : undefined;
	return target.closest('[contenteditable]:not([contenteditable="false"])')
		? target
		: undefined;
}

/** Whether the caret rests at the very start (`up`) or very end of the field with nothing selected. */
function atEdge(field: HTMLElement, up: boolean): boolean {
	if (field instanceof HTMLSelectElement) return false;
	if (
		field instanceof HTMLTextAreaElement ||
		field instanceof HTMLInputElement
	) {
		if (field.value === "") return true;
		const { selectionStart: start, selectionEnd: end } = field;
		if (start === null || end === null || start !== end) return false;
		return up ? start === 0 : start === field.value.length;
	}
	if ((field.textContent ?? "") === "") return true;
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || !selection.isCollapsed)
		return false;
	const caret = selection.getRangeAt(0);
	const side = document.createRange();
	side.selectNodeContents(field);
	if (up) side.setEnd(caret.startContainer, caret.startOffset);
	else side.setStart(caret.endContainer, caret.endOffset);
	return side.toString() === "";
}

/** What a key press asks for, or nothing when it is not ours to act on. */
export function classify(event: KeyboardEvent): Shortcut | undefined {
	if (event.defaultPrevented || composingKey(event)) return undefined;
	const { key } = event;
	if (key === "Escape")
		return event.altKey || event.ctrlKey || event.metaKey
			? undefined
			: "escape";
	if (event.altKey && !event.ctrlKey && !event.metaKey) {
		if (key !== "ArrowUp" && key !== "ArrowDown") return undefined;
		const up = key === "ArrowUp";
		const field = editable(event.target);
		if (field && !atEdge(field, up)) return undefined;
		if (event.shiftKey) return up ? "previous-unread" : "next-unread";
		return up ? "previous" : "next";
	}
	if (key === "?" && !event.ctrlKey && !event.metaKey && !event.repeat)
		return editable(event.target) ? undefined : "help";
	return undefined;
}

/** The finished threads whose fold is open now; the fold's state is the page's, not the store's. */
function openFolds(): Set<string> {
	const keys = new Set<string>();
	for (const card of document.querySelectorAll<HTMLElement>(
		"details.thread-closed[open] [data-thread]",
	))
		if (card.dataset.thread) keys.add(card.dataset.thread);
	return keys;
}

/** A menu, sheet or drawer is open over the page: the keys are its, not the page's. */
const overlayOpen = (): boolean =>
	document.querySelector(
		'dialog[open], .action-popover, .switcher:not([data-state="closed"])',
	) !== null;

/** Scrolls the open room's row into view in the list once the page has drawn it; no list, no scroll. */
function reveal(key: string, frames = 12): void {
	const href = hrefFor("room", key);
	const row = [
		...document.querySelectorAll<HTMLElement>(
			'.room-row[aria-current="page"], .thread-link[aria-current="page"]',
		),
	].find((one) => one.getAttribute("href") === href);
	if (row) row.scrollIntoView?.({ block: "nearest" });
	else if (frames > 0) requestAnimationFrame(() => reveal(key, frames - 1));
}

/** Goes to the room before or after the open one, as clicking its row would. */
function stepRoom(direction: 1 | -1, unread: boolean): void {
	const state = store.getState();
	const route = currentRoute();
	const current = route.pane === "room" ? route.key : undefined;
	const stops = roomStops(state, {
		at: (key) => activityAt(state, key),
		collapsed: collapsedNow(),
		expanded: openFolds(),
		current,
	});
	// A room open that the list does not hold (a host's room) is left where it is.
	if (route.pane === "room" && !stops.some((stop) => stop.key === current))
		return;
	const wanted = unread
		? (stop: Stop) => unreadOf(stop.key) > 0
		: (stop: Stop) => stop.shown;
	const next = neighbour(stops, current, direction, wanted);
	if (next === undefined) return;
	navigate("room", next);
	reveal(next);
}

/** Esc: the topmost menu or sheet closes (a sheet does it itself); with none open the message box lets go. */
function leave(event: KeyboardEvent): void {
	if (document.querySelector(".action-popover")) {
		event.preventDefault();
		closeMenu();
		return;
	}
	if (document.querySelector("dialog[open]")) return;
	const active = document.activeElement;
	if (
		active instanceof HTMLTextAreaElement ||
		(active instanceof HTMLInputElement && TEXT_INPUTS.has(active.type))
	) {
		// Esc also empties a search field by default; the text stays.
		event.preventDefault();
		active.blur();
	}
}

/** Does what `shortcut` asks for. */
export function run(shortcut: Shortcut, event: KeyboardEvent): void {
	switch (shortcut) {
		case "escape":
			leave(event);
			break;
		case "help":
			event.preventDefault();
			if (shortcutHelpOpen()) closeShortcutHelp();
			else if (!overlayOpen()) openShortcutHelp();
			break;
		default:
			// Behind an open menu, sheet or drawer the room stays where it is.
			if (overlayOpen()) break;
			event.preventDefault();
			stepRoom(
				shortcut.startsWith("previous") ? -1 : 1,
				shortcut.endsWith("unread"),
			);
	}
}

/** Listens for the shortcuts; returns the call that stops. */
export function startShortcuts(): () => void {
	const onKey = (event: KeyboardEvent) => {
		const shortcut = classify(event);
		if (shortcut) run(shortcut, event);
	};
	window.addEventListener("keydown", onKey);
	return () => window.removeEventListener("keydown", onKey);
}
