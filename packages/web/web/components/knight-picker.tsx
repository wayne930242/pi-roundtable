import { useMemo } from "react";
import { useSelector } from "../lib/app-store.ts";

/** Splits the names of one agent from its display name in the selector's one string. */
const SEP = "\u0000";

/** The knights a person can pick: the active ones the room list has, temp knights left out. */
export function useKnights(): { name: string; displayName: string }[] {
	// One string, so a picker redraws only when the knights change, not on every message.
	const shape = useSelector((state) =>
		state.order
			.flatMap((key) => {
				const view = state.rooms[key]?.view;
				return view?.kind === "agent" && !view.helper
					? [`${view.name}${SEP}${view.displayName}`]
					: [];
			})
			.join(`${SEP}${SEP}`),
	);
	return useMemo(
		() =>
			shape === ""
				? []
				: shape.split(`${SEP}${SEP}`).map((one) => {
						const [name = "", displayName = ""] = one.split(SEP);
						return { name, displayName };
					}),
		[shape],
	);
}

/**
 * Several knights picked from the active ones, a checkbox each; `chosen` keeps the order they were
 * picked in. `max` stops more being picked, and `except` leaves knights out of the list.
 */
export function KnightPicker(props: {
	label: string;
	hint?: string;
	chosen: readonly string[];
	onChange(chosen: string[]): void;
	max?: number;
	except?: readonly string[];
}) {
	const { chosen, max } = props;
	const knights = useKnights().filter(
		(knight) => !props.except?.includes(knight.name),
	);
	return (
		<fieldset className="field">
			<legend>{props.label}</legend>
			{props.hint ? <span className="meta">{props.hint}</span> : null}
			<ul className="menu">
				{knights.map((knight) => {
					const on = chosen.includes(knight.name);
					return (
						<li key={knight.name}>
							<label className="menu-item menu-toggle">
								<input
									type="checkbox"
									checked={on}
									disabled={!on && max !== undefined && chosen.length >= max}
									onChange={() =>
										props.onChange(
											on
												? chosen.filter((one) => one !== knight.name)
												: [...chosen, knight.name],
										)
									}
								/>
								<span className="menu-text">
									<strong>{knight.displayName}</strong>
								</span>
							</label>
						</li>
					);
				})}
			</ul>
		</fieldset>
	);
}
