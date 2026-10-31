import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { draftOf, onMentionRequested, withMention } from "./drafts.ts";

/**
 * How a name gets into the composer's text from outside the typing: a tap on a knight asks the
 * room's box to mention it (at its caret, or after the text when the box is not the one in use),
 * and a pick from the member list puts its own text in. The box takes the focus and puts the caret
 * after the mention once it shows the text. `put` is for a text made elsewhere.
 */
export function useMentionInsert(
	draftKey: string | undefined,
	area: RefObject<HTMLTextAreaElement | null>,
	typed: RefObject<string>,
	text: string,
	setText: (text: string) => void,
): (made: { text: string; caret: number }) => void {
	/** Where a mention put the caret; the box takes it once it shows the text. */
	const caretAt = useRef<number | undefined>(undefined);
	const put = (made: { text: string; caret: number }) => {
		caretAt.current = made.caret;
		typed.current = made.text;
		setText(made.text);
		area.current?.focus();
	};
	const latest = useRef(put);
	latest.current = put;
	useEffect(() => {
		if (draftKey === undefined) return;
		return onMentionRequested(draftKey, (name) => {
			const element = area.current;
			// The box in use takes the mention where its caret is; otherwise it goes after the text.
			const inBox = element !== null && document.activeElement === element;
			latest.current(
				inBox
					? withMention(
							element.value,
							name,
							element.selectionStart,
							element.selectionEnd,
						)
					: withMention(element?.value ?? draftOf(draftKey), name),
			);
		});
	}, [draftKey, area]);
	// Before the member list reads the caret, which it does in an effect of its own.
	useLayoutEffect(() => {
		const element = area.current;
		if (!element || caretAt.current === undefined) return;
		const at = Math.min(caretAt.current, text.length);
		caretAt.current = undefined;
		element.focus();
		element.setSelectionRange(at, at);
	}, [text, area]);
	return put;
}
