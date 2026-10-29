// The builders of every menu, asked for as the menu opens. Their code (the clipboard, sharing, the
// profile, the confirms) loads with the first menu, not with the page.

import type {
	PromptFrame,
	RoomFile,
	RoomMessage,
} from "../../src/api-types.ts";
import type { Leave, MenuSpec } from "./menu-items.ts";

const items = () => import("./menu-items.ts");

export const roomMenuOf = (
	key: string,
	leave?: Leave,
): Promise<MenuSpec | undefined> =>
	items().then((one) => one.roomMenu(key, leave));

export const messageMenuOf = (
	message: RoomMessage,
	source: HTMLElement,
	quotable: boolean,
): Promise<MenuSpec> =>
	items().then((one) => one.messageMenu(message, source, quotable));

export const avatarMenuOf = (
	agent: string,
	author: string,
): Promise<MenuSpec> => items().then((one) => one.avatarMenu(agent, author));

export const cardMenuOf = (frame: PromptFrame): Promise<MenuSpec> =>
	items().then((one) => one.cardMenu(frame));

export const fileMenuOf = (file: RoomFile): Promise<MenuSpec> =>
	items().then((one) => one.fileMenu(file));

/** Opens the "+" menu under a button: a new agent, a new group, and the archive. */
export const openAddMenu = (button: HTMLElement, leave?: Leave): void =>
	void items().then((one) => one.openAddMenu(button, leave));
