// The one action menu of the page: a long press, a right click or the Menu key asks for it with
// `openMenu`, and `ActionMenuHost` (mounted once, in the app) draws it.

import type { IconName } from "../components/icons.tsx";
import type { Point, Via } from "./long-press.ts";
import { signal } from "./signal.ts";

/** One action of a menu. */
export interface MenuItem {
	id: string;
	label: string;
	icon?: IconName;
	tone?: "yolo" | "long" | "danger";
	/** A toggle: whether it is on now. The label names the thing, not the change. */
	checked?: boolean;
	/** Runs once the menu is gone. */
	run(): void | Promise<void>;
}

export interface MenuRequest {
	title: string;
	items: readonly MenuItem[];
	/** Where the press was, in viewport coordinates; a popover opens there. */
	at: Point;
	via: Via;
	/** What had focus, or was pressed; it gets focus back when the menu closes. */
	source: HTMLElement | null;
}

export interface OpenMenu extends MenuRequest {
	/** Counts the menus opened, so the host can tell a new menu from the same one drawn again. */
	serial: number;
}

let current: OpenMenu | undefined;
let serial = 0;
const { emit, use } = signal();

/** Opens the menu; a menu with nothing in it does not open. */
export function openMenu(request: MenuRequest): void {
	if (request.items.length === 0) return;
	serial += 1;
	current = { ...request, serial };
	emit();
}

/** Closes the menu without running anything. */
export function closeMenu(): void {
	if (!current) return;
	current = undefined;
	emit();
}

export const useOpenMenu = (): OpenMenu | undefined => use(() => current);
