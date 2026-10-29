import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSelector } from "../lib/app-store.ts";
import { useLook } from "../lib/look.ts";
import { translate as t } from "../lib/messages.ts";
import { Icon } from "./icons.tsx";
import { RoundTable } from "./round-table.tsx";

/** Where a piece of the table goes when the header gives it a place; inline when it does not. */
const placed = (node: ReactNode, slot: HTMLElement | null | undefined) =>
	slot ? createPortal(node, slot) : node;

/**
 * A group room's "Table" toggle. On, the room's whole conversation runs in the round table scene
 * (the page swaps the list for it) and the choice is kept per room; off, the list stays and, under
 * Camelot, a compact strip of the members stands under the header, lit on whoever speaks. `slot` is
 * the element under the header the strip goes into.
 */
export function GroupTable(props: {
	roomKey: string;
	slot?: HTMLElement | null | undefined;
	/** The room shows the scene. */
	scene: boolean;
	onScene(on: boolean): void;
}) {
	const view = useSelector((state) => state.rooms[props.roomKey]?.view);
	const look = useLook();
	if (!view || view.kind !== "group") return null;
	const members = view.members ?? [];
	return (
		<>
			<button
				type="button"
				className="icon-button group-table-button"
				aria-label={t("Table")}
				aria-pressed={props.scene}
				onClick={() => props.onScene(!props.scene)}
			>
				<Icon name="table" />
				<span className="group-table-label">{t("Table")}</span>
			</button>
			{look === "camelot" && !props.scene
				? placed(
						<div className="group-strip">
							<RoundTable
								members={members}
								groupRoom={props.roomKey}
								variant="compact"
							/>
						</div>,
						props.slot,
					)
				: null}
		</>
	);
}
