/** An on/off control that reads as a switch to a screen reader; its thumb slides on `transform`. */
export function Switch(props: {
	/** The id a label points at, so a tap on the label flips the switch. */
	id?: string;
	checked: boolean;
	onChange(next: boolean): void;
	label: string;
	busy?: boolean;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			id={props.id}
			role="switch"
			aria-checked={props.checked}
			aria-label={props.label}
			aria-busy={props.busy || undefined}
			disabled={props.disabled || props.busy}
			className="switch"
			onClick={() => props.onChange(!props.checked)}
		>
			<span className="switch-thumb" />
		</button>
	);
}
