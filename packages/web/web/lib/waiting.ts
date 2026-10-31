// The cards that wait on the person, and the way to them: the top bar's button asks for them with
// `openWaiting`, which goes straight to a single card or opens the list (`WaitingSheetHost`), and a
// jump leaves the card as the room's target, which `waiting-chip.tsx` scrolls to once the room
// shows it. The server only sends a socket the cards its person may answer, so every open card in
// the state is one of theirs. A lazy module: the button imports it on its first press.

import { store } from "./app-store.ts";
import { reducedMotion } from "./motion.ts";
import type { CardState, RoomsState } from "./rooms.ts";
import { navigate } from "./router.ts";
import { signal } from "./signal.ts";

const { emit, use } = signal();
let listOpen = false;
let target: string | undefined;

/** The open cards, oldest first. */
export function waitingList(
	state: Pick<RoomsState, "cards" | "cardOrder">,
): Array<{ id: string; card: CardState }> {
	return state.cardOrder.flatMap((id) => {
		const card = state.cards[id];
		return card && !card.outcome ? [{ id, card }] : [];
	});
}

/** One card waiting: its room, at the card. Several: the list of them. */
export function openWaiting(): void {
	const open = waitingList(store.getState());
	const [only] = open;
	if (open.length === 1 && only) jumpToCard(only.id);
	else if (open.length > 1) {
		listOpen = true;
		emit();
	}
}

export function closeWaitingList(): void {
	if (!listOpen) return;
	listOpen = false;
	emit();
}

export const useWaitingList = (): boolean => use(() => listOpen);

/** Opens the card's room (a dispatch thread is a room too), to show the card there. */
export function jumpToCard(id: string): void {
	const card = store.getState().cards[id];
	if (!card) return;
	listOpen = false;
	target = id;
	emit();
	navigate("room", card.room);
}

/** The card a jump left for the room to show; none once it was shown. */
export const useTarget = (): string | undefined => use(() => target);

/** The room showed the card, so the jump is done. */
export function targetShown(id: string): void {
	if (target !== id) return;
	target = undefined;
	emit();
}

/** The room's row that holds the card, if the room shows it. */
export const cardSlot = (
	root: ParentNode | null,
	id: string,
): HTMLElement | undefined =>
	[...(root?.querySelectorAll<HTMLElement>("[data-card]") ?? [])].find(
		(slot) => slot.dataset.card === id,
	);

/** How long a card that was jumped to stays lit. */
const LIT_MS = 1600;

/** Brings the card into the middle of the room, lights it a moment and puts focus on it; false when the room does not show it. */
export function showCard(root: HTMLElement | null, id: string): boolean {
	const slot = cardSlot(root, id);
	if (!slot) return false;
	slot.scrollIntoView?.({
		block: "center",
		behavior: reducedMotion() ? "auto" : "smooth",
	});
	const card = slot.querySelector<HTMLElement>(".prompt") ?? slot;
	card.tabIndex = -1;
	card.focus({ preventScroll: true });
	slot.dataset.lit = "";
	setTimeout(() => delete slot.dataset.lit, LIT_MS);
	return true;
}
