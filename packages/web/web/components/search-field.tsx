import { useId } from "react";
import { installAgentSheetStyle } from "../lib/agent-sheet-style.ts";
import type { FieldLook } from "../lib/field-look.ts";
import { TextField } from "./fields.tsx";
import { Icon } from "./icons.tsx";

/** A search box with the search icon beside it; `label` is its placeholder and its name. The look is the box's. */
export function SearchField(
	props: {
		label: string;
		value: string;
		onChange(value: string): void;
	} & FieldLook,
) {
	const id = useId();
	installAgentSheetStyle();
	return (
		<label className="search-field" htmlFor={id}>
			<Icon name="search" size={16} />
			<TextField
				id={id}
				type="search"
				size={props.size}
				tone={props.tone}
				variant={props.variant}
				aria-label={props.label}
				placeholder={props.label}
				value={props.value}
				onChange={(event) => props.onChange(event.target.value)}
			/>
		</label>
	);
}
