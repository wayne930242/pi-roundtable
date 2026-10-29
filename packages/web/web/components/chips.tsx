/** A choice among a few, as chips: the one that is on is pressed. */
export function Chips(props: {
	label: string;
	value: string;
	options: readonly { value: string; label: string }[];
	onChange(value: string): void;
}) {
	return (
		<fieldset className="field">
			<legend>{props.label}</legend>
			<div className="option-chips">
				{props.options.map((option) => (
					<button
						key={option.value}
						type="button"
						aria-pressed={option.value === props.value}
						className="option-chip"
						onClick={() => props.onChange(option.value)}
					>
						{option.label}
					</button>
				))}
			</div>
		</fieldset>
	);
}
