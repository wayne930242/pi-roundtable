import { type RefObject, useEffect, useState } from "react";
import { useSelector } from "../lib/app-store.ts";
import { installStyle } from "../lib/lazy-style.ts";
import { plural } from "../lib/messages.ts";
import {
	cardSlot,
	showCard,
	targetShown,
	useTarget,
	waitingList,
} from "../lib/waiting.ts";
import { Icon } from "./icons.tsx";

/** How long after a jump a log drawn anew shows the card again. */
const SETTLE_MS = 1500;

const WAITING_CSS = `
.waiting-chip-slot {
	position: relative;
	z-index: 3;
	height: 0;
}

.waiting-chip {
	position: absolute;
	top: var(--space-2);
	left: 50%;
	min-height: 2.25rem;
	padding: 0 var(--space-3);
	border-radius: var(--radius-full);
	border-color: transparent;
	background: var(--warn);
	color: var(--bg);
	box-shadow: var(--shadow-2);
	transform: translateX(-50%);
	animation: toast-in var(--dur-slow) var(--ease-spring) both;
}

.slot[data-lit] > .prompt {
	outline: 3px solid var(--warn);
	outline-offset: 3px;
	transition: outline-color var(--dur-slow) var(--ease-out);
}
`;

/**
 * The room's part of the waiting cards: a chip over the messages while one of its waiting cards is
 * out of view, which brings it back, and the card a jump from elsewhere asked for, shown once the
 * room's history is in. A lazy chunk, mounted only while the room has a card waiting.
 */
export default function WaitingChip(props: {
	roomKey: string;
	scroller: RefObject<HTMLDivElement | null>;
	loaded: boolean;
}) {
	installStyle("waiting", WAITING_CSS);
	const { roomKey, scroller, loaded } = props;
	const ids = useSelector(
		(state) =>
			waitingList(state)
				.filter((entry) => entry.card.room === roomKey)
				.map((entry) => entry.id)
				.join(" "),
		roomKey,
	);
	const target = useTarget();
	const [hidden, setHidden] = useState<string[]>([]);

	// Which of the room's waiting cards the scroller does not show.
	useEffect(() => {
		const root = scroller.current;
		if (!root || !loaded || typeof IntersectionObserver === "undefined") return;
		const inView = new Map<string, boolean>();
		const watch = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const id = (entry.target as HTMLElement).dataset.card;
					if (id) inView.set(id, entry.isIntersecting);
				}
				setHidden([...inView].flatMap(([id, shown]) => (shown ? [] : [id])));
			},
			{ root },
		);
		for (const id of ids.split(" ")) {
			const slot = id ? cardSlot(root, id) : undefined;
			if (slot) watch.observe(slot);
		}
		return () => watch.disconnect();
	}, [ids, scroller, loaded]);

	// A jump to one of this room's cards: shown after the room's own first move to its end, and
	// shown again if the log is drawn anew meanwhile (its full version loads after the first paint).
	useEffect(() => {
		const root = scroller.current;
		if (!root || !loaded || !target || !ids.split(" ").includes(target)) return;
		let shown: HTMLElement | undefined;
		const show = () => {
			const slot = cardSlot(root, target);
			if (!slot || slot === shown) return;
			shown = slot;
			showCard(root, target);
		};
		const frame = requestAnimationFrame(show);
		const redrawn =
			typeof MutationObserver === "undefined"
				? undefined
				: new MutationObserver(show);
		redrawn?.observe(root, { childList: true, subtree: true });
		const done = setTimeout(() => targetShown(target), SETTLE_MS);
		return () => {
			cancelAnimationFrame(frame);
			redrawn?.disconnect();
			clearTimeout(done);
		};
	}, [loaded, target, ids, scroller]);

	const count = ids ? ids.split(" ").length : 0;
	const [first] = hidden;
	return (
		<div className="waiting-chip-slot">
			{first && count ? (
				<button
					type="button"
					className="waiting-chip"
					onClick={() => showCard(scroller.current, first)}
				>
					<Icon name="shield" size={16} />
					{plural(
						count,
						"{count} card waiting for an answer",
						"{count} cards waiting for an answer",
					)}
				</button>
			) : null}
		</div>
	);
}
