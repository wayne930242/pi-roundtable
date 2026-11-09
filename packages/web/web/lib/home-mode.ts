// What the app opens on, as the host chose it (`appearance.home`): the arranged room list or the chat
// list. Read by code outside a component, as the rooms sync and the room menu are.

export type HomeMode = "rooms" | "chats";

let mode: HomeMode = "rooms";

/** Sets the home from the config; the page calls it once the config is in. */
export function setHomeMode(next: HomeMode): void {
	mode = next;
}

/** Whether the app opens on the chat list, where rooms can be hidden. */
export const chatsHome = (): boolean => mode === "chats";
