import type { ComponentProps, ReactNode } from "react";
import {
	type AriaInvalid,
	type FieldLook,
	type FieldSize,
	type FieldTone,
	installFieldStyle,
	type LookAttributes,
	lookAttributes,
} from "../lib/field-look.ts";
import { BareInput, BareTextArea } from "./bare-fields.tsx";

// The page's form controls, one component for each kind, so no page or component writes an
// `<input>` or a `<textarea>` of its own (`form-controls.test.ts` checks) and a kind has one place
// to change. Each draws the native control, through the bare ones of `bare-fields.tsx`, and passes every attribute and the `ref` on to it. With
// no look set the control is the page's own (`styles.css` gives `input` and `textarea` their box,
// focus ring and phone text size); `size`, `tone` and `variant` come from the one stylesheet of
// `lib/field-look.ts`. A room's composer and its question cards, which the page's first chunk
// carries, take the bare controls of `bare-fields.tsx` directly, and not this file, whose look
// loads with the lazy parts.

// The drop-down has a file and a stylesheet of its own and is taken from here like the others:
// with one module for every control the fields and the drop-down load as one lazy chunk, and the
// first load lists each chunk a lazy part needs (`src/page.test.ts` holds its budget).
export { Select } from "./select.tsx";

type InputProps = Omit<ComponentProps<"input">, "type" | "size">;

/** A control's own attributes, with its look turned into the attributes the stylesheet reads. */
function withLook<P extends FieldLook & { "aria-invalid"?: AriaInvalid }>(
	props: P,
): Omit<P, keyof FieldLook> & LookAttributes {
	const { size, tone, variant, ...rest } = props;
	return {
		...rest,
		...lookAttributes({ size, tone, variant }, props["aria-invalid"]),
	};
}

/** One line of text. The other kinds of `<input>` each have a component of their own. */
export function TextField(
	props: InputProps &
		FieldLook & { type?: "text" | "search" | "url" | "password" },
) {
	return <BareInput {...withLook(props)} />;
}

/** Text of more than one line. */
export function TextArea(props: ComponentProps<"textarea"> & FieldLook) {
	return <BareTextArea {...withLook(props)} />;
}

/** A day, chosen in the system's date picker; its value is `YYYY-MM-DD` or empty. */
export function DateField(props: InputProps & FieldLook) {
	return <BareInput {...withLook(props)} type="date" />;
}

/** The look of a control the browser draws: its size and the colour of its tick, with no box to fill. */
type MarkLook = Pick<FieldLook, "size" | "tone">;

/** A tick box: one of several that may be chosen together. Ticked, it is the accent colour, or its tone's. */
export function Checkbox(props: InputProps & MarkLook) {
	return <BareInput {...withLook(props)} type="checkbox" />;
}

/** A radio button: one of the choices that share its `name`. Chosen, it is the accent colour, or its tone's. */
export function Radio(props: InputProps & MarkLook) {
	return <BareInput {...withLook(props)} type="radio" />;
}

/** A colour, chosen in the system's colour picker; its value is `#rrggbb`. */
export function ColorField(props: InputProps & MarkLook) {
	return <BareInput {...withLook(props)} type="color" />;
}

/**
 * The words under a field: a hint, or what is wrong with it, in the field's tone. `id` is what the
 * field's `aria-describedby` names. A note in `danger` is announced when it appears.
 */
export function FieldNote(props: {
	id?: string;
	size?: FieldSize;
	tone?: FieldTone;
	children: ReactNode;
}) {
	installFieldStyle();
	return (
		<p
			id={props.id}
			className="field-note"
			role={props.tone === "danger" ? "alert" : undefined}
			{...lookAttributes({ size: props.size, tone: props.tone })}
		>
			{props.children}
		</p>
	);
}
