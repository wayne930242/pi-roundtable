import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { withMention } from "../lib/drafts.ts";
import { composingKey } from "../lib/ime.ts";
import { installStyle } from "../lib/lazy-style.ts";
import { MENTION_MENU_CSS } from "../lib/mention-menu-style.ts";
import {
	type Mentionable,
	matchMembers,
	mentionTrigger,
} from "../lib/mention-pick.ts";
import { translate as t } from "../lib/messages.ts";

/**
 * The members a message box offers while an `@` is being typed at a word start, over the box and
 * filtered as the name grows. Arrows move, Enter or Tab pick, Escape closes, a tap picks; none of
 * them acts while an input method composes. The box keeps the focus throughout. It listens on the
 * box itself, ahead of the box's own keys, so Enter picks instead of sending while it is open.
 */
export function MentionMenu(props: {
	area: RefObject<HTMLTextAreaElement | null>;
	text: string;
	members: readonly Mentionable[];
	onPick(made: { text: string; caret: number }): void;
}) {
	const { area, text, members, onPick } = props;
	installStyle("mention-menu", MENTION_MENU_CSS);
	const id = useId();
	/** The caret as the box has it once it shows `text`; a caret read for other text is not this draw's. */
	const [seen, setSeen] = useState<{ text: string; caret: number }>();
	const [active, setActive] = useState(0);
	/** The `@` that Escape closed the list for. */
	const [closed, setClosed] = useState<number>();
	const readCaret = useRef(() => {});
	readCaret.current = () => {
		const box = area.current;
		setSeen(
			box && document.activeElement === box
				? { text: box.value, caret: box.selectionStart }
				: undefined,
		);
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new text is a new draw to read the caret for
	useEffect(() => readCaret.current(), [text]);
	const trigger =
		seen?.text === text ? mentionTrigger(text, seen.caret) : undefined;
	const items = trigger ? matchMembers(members, trigger.query) : [];
	const open =
		trigger !== undefined && items.length > 0 && closed !== trigger.from;
	const shown = Math.min(active, Math.max(items.length - 1, 0));

	/** Puts the member in where the `@word` at the caret stands, read live: the caret may have moved since the last draw. */
	const pick = (member: Mentionable) => {
		const box = area.current;
		if (!box) return;
		const at = box.selectionStart;
		const found = mentionTrigger(box.value, at);
		if (found)
			onPick(withMention(box.value, member.displayName, found.from, at));
	};
	const latest = useRef({ open, items, shown, pick, trigger });
	latest.current = { open, items, shown, pick, trigger };

	useEffect(() => {
		const box = area.current;
		if (!box) return;
		// The caret is read again whenever it moves without the text changing.
		const reread = () => readCaret.current();
		document.addEventListener("selectionchange", reread);
		box.addEventListener("keyup", reread);
		box.addEventListener("click", reread);
		const onKey = (event: KeyboardEvent) => {
			const now = latest.current;
			if (!now.open || composingKey(event)) return;
			if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
				return;
			const last = now.items.length - 1;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				setActive(
					event.key === "ArrowDown"
						? now.shown >= last
							? 0
							: now.shown + 1
						: now.shown <= 0
							? last
							: now.shown - 1,
				);
			} else if (event.key === "Enter" || event.key === "Tab") {
				const one = now.items[now.shown];
				if (one) now.pick(one);
			} else if (event.key === "Escape") setClosed(now.trigger?.from);
			else return;
			event.preventDefault();
			event.stopPropagation();
		};
		box.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("selectionchange", reread);
			box.removeEventListener("keyup", reread);
			box.removeEventListener("click", reread);
			box.removeEventListener("keydown", onKey);
		};
	}, [area]);

	const query = trigger?.query;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new name starts at the first match
	useEffect(() => setActive(0), [query]);
	const listed = open;
	useEffect(() => {
		const box = area.current;
		if (!box || !listed) return;
		box.setAttribute("aria-controls", id);
		box.setAttribute("aria-activedescendant", `${id}-${shown}`);
		return () => {
			box.removeAttribute("aria-controls");
			box.removeAttribute("aria-activedescendant");
		};
	}, [area, id, listed, shown]);

	if (!open) return null;
	return (
		<div
			id={id}
			className="mention-menu"
			role="listbox"
			aria-label={t("Members")}
		>
			{items.map((member, index) => (
				<div key={member.name} role="presentation">
					<button
						type="button"
						role="option"
						id={`${id}-${index}`}
						aria-selected={index === shown}
						// The press keeps the focus in the box; the tap picks.
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => pick(member)}
					>
						{member.displayName}
					</button>
				</div>
			))}
		</div>
	);
}
