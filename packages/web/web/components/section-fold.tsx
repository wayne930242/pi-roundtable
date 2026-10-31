import "../lib/layout-icons.ts";
import { type ReactNode, useId } from "react";
import { installArrangedStyle } from "../lib/arranged-style.ts";
import { toggleCollapsed, useCollapsed } from "../lib/folds.ts";
import { plural } from "../lib/messages.ts";
import { useStaying } from "../lib/staying.ts";
import { Icon } from "./icons.tsx";

installArrangedStyle();

/**
 * The button a group's heading wears (a section's title, a drawer's heading): a chevron, the name and,
 * while some rooms are folded away, how many rooms the group holds. `aria-expanded` tells whether the
 * group is open, so the heading keeps its own name.
 */
export function FoldToggle(props: {
	id: string;
	name: string;
	open: boolean;
	/** The element that holds the group's rooms. */
	controls: string;
	/** The rooms in the group, shown while it is folded. */
	count?: number | undefined;
}) {
	const { name, open } = props;
	return (
		<button
			type="button"
			className="fold-toggle"
			aria-expanded={open}
			aria-controls={props.controls}
			onClick={() => toggleCollapsed(props.id)}
		>
			<Icon
				name="chevron"
				size={14}
				className="folder-chevron"
				data-open={open || undefined}
			/>
			<span>{name}</span>
			{props.count === undefined ? null : (
				<span className="meta">
					{plural(props.count, "{count} room", "{count} rooms")}
				</span>
			)}
		</button>
	);
}

/**
 * A headed section of the room list whose heading folds it. A folded section keeps the open room and
 * the rooms with a card waiting or messages unread under its heading; `children` draws the rows of the
 * keys it is given.
 */
export default function SectionFold(props: {
	id: string;
	title: string;
	rooms: string[];
	active: string | undefined;
	/** Extra attributes of the section, such as its drop zone. */
	attrs?: Record<string, string>;
	children(keys: string[]): ReactNode;
}) {
	const folded = useCollapsed().has(props.id);
	const staying = useStaying(props.rooms, props.active);
	const shown = folded ? staying : props.rooms;
	const bodyId = useId();
	return (
		<section className="stack" {...props.attrs}>
			<h2 className="section-title">
				<FoldToggle
					id={props.id}
					name={props.title}
					open={!folded}
					controls={bodyId}
					count={folded ? props.rooms.length : undefined}
				/>
			</h2>
			<div id={bodyId} hidden={shown.length === 0}>
				{shown.length === 0 ? null : props.children(shown)}
			</div>
		</section>
	);
}
