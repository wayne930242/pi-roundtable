import type { ComponentProps } from "react";

// The two native controls with no look: the page's own box, focus ring and phone text size from
// `styles.css` and nothing else. The parts the page draws before any lazy part loads (a room's
// composer and its question cards) take these, and `fields.tsx` builds its fields on them, so
// every control of the page is written in one of the two files. This file imports nothing of the
// look (`lib/field-look.ts` and its stylesheet load with the lazy parts), so it adds only these
// two passthroughs to the first load.

/** An `<input>` of any type, with every attribute and the `ref` passed on. */
export function BareInput(props: ComponentProps<"input">) {
	return <input {...props} />;
}

/** A `<textarea>`, with every attribute and the `ref` passed on. */
export function BareTextArea(props: ComponentProps<"textarea">) {
	return <textarea {...props} />;
}
