import { installModeToggleStyle } from "../lib/mode-toggle-style.ts";

installModeToggleStyle();

/**
 * The composer's one choice of how to write: off is a note for the room's people only, on is
 * talking to the agent, which answers. It reads as a switch, keeps its label in both states, and
 * stands in the composer's column (pass it as the composer's `above`). A page that reads the
 * typed text locks it on while the text carries `@AI`.
 */
export function ModeToggle(props: {
	on: boolean;
	label: string;
	/** Something the person typed holds it on: it cannot be turned off from here, and says why. */
	locked?: string;
	onChange(next: boolean): void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={props.on}
			className="mode-toggle"
			disabled={props.locked !== undefined}
			title={props.locked}
			onClick={() => props.onChange(!props.on)}
		>
			<span className="mode-toggle-track" aria-hidden="true" />
			{props.label}
		</button>
	);
}
