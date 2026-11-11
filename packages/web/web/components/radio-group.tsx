import type { ReactNode } from "react";
import {
	type FieldLook,
	installFieldStyle,
	lookAttributes,
} from "../lib/field-look.ts";
import { Radio } from "./fields.tsx";

/**
 * A short list of choices of which one holds, each a row with its radio button before its words.
 * `legend` names the group for a screen reader only; the heading above the list is what a reader
 * sees. `size` sets the rows and their buttons, `tone` the buttons' colour.
 */
export function RadioGroup<T extends string>(
	props: {
		legend: string;
		/** The `name` the radio buttons share. */
		name: string;
		value: T | undefined;
		options: readonly { value: T; label: ReactNode }[];
		onChange(value: T): void;
	} & Pick<FieldLook, "size" | "tone">,
) {
	installFieldStyle();
	const { size, tone } = props;
	return (
		<fieldset
			className="radio-group"
			data-size={lookAttributes({ size })["data-size"]}
		>
			<legend className="visually-hidden">{props.legend}</legend>
			{props.options.map((option) => (
				<label key={option.value}>
					<Radio
						size={size}
						tone={tone}
						name={props.name}
						checked={props.value === option.value}
						onChange={() => props.onChange(option.value)}
					/>
					{option.label}
				</label>
			))}
		</fieldset>
	);
}
