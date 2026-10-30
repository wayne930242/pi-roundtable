import type { RoomsState } from "./rooms.ts";
import { signal } from "./signal.ts";

// What the tab's title and icon count beyond the cards that wait: the notices and the unread
// messages. It is a few lines because the title is drawn in the first load; `tab-dot.ts`, a lazy
// module, keeps the count and swaps the icon.

const { emit, use } = signal();
let unread = 0;

/** The notices waiting and the unread messages, as `tab-dot.ts` last counted them. */
export function setTabUnread(count: number): void {
	if (count === unread) return;
	unread = count;
	emit();
}

export const useTabUnread = (): number => use(() => unread);

/** How many cards wait for an answer, in every room. */
export const openCards = (state: RoomsState): number =>
	state.cardOrder.filter((id) => !state.cards[id]?.outcome).length;

/** The tab's title: the page's own, led by `(N) ` while anything waits. */
export const tabTitle = (title: string, count: number): string =>
	count > 0 ? `(${count}) ${title}` : title;
