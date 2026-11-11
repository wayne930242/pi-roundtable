import type { ChangeEvent, ReactNode } from "react";
import {
	type FieldLook,
	installFieldStyle,
	lookAttributes,
} from "../lib/field-look.ts";
import { Radio } from "./fields.tsx";

/**
 * A short row of choices of which one holds, drawn as one bar. Each choice is a native radio
 * button, hidden under its label, so the arrow keys move within the group and the focus ring is
 * the label's. `legend` names the group for a screen reader only. `size` sets the bar's height and
 * `tone` its border and focus colour; `wide` fills the row and shares it between the choices.
 * `className` adds a caller's own class to the bar for its own rules.
 */
export function Segmented<T extends string>(
	props: {
		legend: string;
		/** The `name` the radio buttons share. */
		name: string;
		value: T | undefined;
		options: readonly {
			value: T;
			label: ReactNode;
			/** A tooltip for the choice. */
			title?: string;
		}[];
		/** Called with the chosen value, and the change event for a caller that needs where it happened. */
		onChange(value: T, event: ChangeEvent<HTMLInputElement>): void;
		wide?: boolean;
		className?: string;
	} & Pick<FieldLook, "size" | "tone">,
) {
	installFieldStyle();
	const { size, tone } = props;
	return (
		<fieldset
			className={props.className ? `segmented ${props.className}` : "segmented"}
			data-wide={props.wide ? "" : undefined}
			{...lookAttributes({ size, tone })}
		>
			<legend className="visually-hidden">{props.legend}</legend>
			{props.options.map((option) => (
				<label
					key={option.value}
					data-checked={props.value === option.value}
					title={option.title}
				>
					<Radio
						name={props.name}
						value={option.value}
						checked={props.value === option.value}
						onChange={(event) => props.onChange(option.value, event)}
					/>
					{option.label}
				</label>
			))}
		</fieldset>
	);
}
