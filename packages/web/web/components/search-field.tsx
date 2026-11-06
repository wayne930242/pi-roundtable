import { useId } from "react";
import { installAgentSheetStyle } from "../lib/agent-sheet-style.ts";
import { Icon } from "./icons.tsx";

/** A search box with the search icon beside it; `label` is its placeholder and its name. */
export function SearchField(props: {
	label: string;
	value: string;
	onChange(value: string): void;
}) {
	const id = useId();
	installAgentSheetStyle();
	return (
		<label className="search-field" htmlFor={id}>
			<Icon name="search" size={16} />
			<input
				id={id}
				type="search"
				aria-label={props.label}
				placeholder={props.label}
				value={props.value}
				onChange={(event) => props.onChange(event.target.value)}
			/>
		</label>
	);
}
