import type { ReactNode } from "react";
import { plural, translate as t } from "../lib/messages.ts";
import { Confirm } from "./confirm.tsx";

/** How many names the question lists before it says "and N more". */
const LISTED = 8;

/** The names a delete is about: the first eight, then how many more. */
export function Names(props: { names: readonly string[] }) {
	const rest = props.names.length - LISTED;
	return (
		<ul className="confirm-names">
			{props.names.slice(0, LISTED).map((name, at) => (
				// A name can repeat (two workspaces called alike), so its place is part of the key.
				// biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed while the question is open
				<li key={`${at}:${name}`}>{name}</li>
			))}
			{rest > 0 ? <li>{t("and {count} more", { count: rest })}</li> : null}
		</ul>
	);
}

/**
 * The question before deleting for good: it names the items, says what goes with them, ends with
 * "This cannot be undone", and the danger button carries the count. Nothing has to be typed.
 */
export function DeleteForGood(props: {
	open: boolean;
	names: readonly string[];
	/** What else the question says, one paragraph each. */
	notes: readonly ReactNode[];
	onConfirm(): Promise<void>;
	onClose(): void;
}) {
	const count = props.names.length;
	return (
		<Confirm
			open={props.open}
			title={plural(
				count,
				"Delete {count} item for good?",
				"Delete {count} items for good?",
			)}
			confirmLabel={t("Delete {count} for good", { count })}
			tone="danger"
			onClose={props.onClose}
			onConfirm={props.onConfirm}
		>
			<Names names={props.names} />
			{props.notes.map((note, at) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the notes are fixed while the question is open
				<p key={at}>{note}</p>
			))}
			<p>
				<strong>{t("This cannot be undone.")}</strong>
			</p>
		</Confirm>
	);
}
