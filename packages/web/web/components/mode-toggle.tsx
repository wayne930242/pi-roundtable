import { installModeToggleStyle } from "../lib/mode-toggle-style.ts";

installModeToggleStyle();

/**
 * The composer's one choice of how to write: off is a note for the room's people only, on is
 * talking to the agent, which answers. It reads as a switch, keeps its label in both states, and
 * stands in the composer's column (pass it as the composer's `above`).
 */
export function ModeToggle(props: {
	on: boolean;
	label: string;
	onChange(next: boolean): void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={props.on}
			className="mode-toggle"
			onClick={() => props.onChange(!props.on)}
		>
			<span className="mode-toggle-track" aria-hidden="true" />
			{props.label}
		</button>
	);
}
