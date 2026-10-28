import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";
import { useSelector } from "../lib/app-store.ts";
import { useLook } from "../lib/look.ts";
import { useMedia } from "../lib/media.ts";
import { translate as t } from "../lib/messages.ts";
import { Icon } from "./icons.tsx";
import { RoundTable } from "./round-table.tsx";
import { Sheet } from "./sheet.tsx";

/** Where a piece of the table goes when the header gives it a place; inline when it does not. */
const placed = (node: ReactNode, slot: HTMLElement | null | undefined) =>
	slot ? createPortal(node, slot) : node;

/**
 * A group room's table. A "Table" button in the header opens the members' round table, in a sheet
 * on a phone and in a panel beside the room elsewhere, with its members also listed as buttons
 * under it: the panel is narrow, and the list names every seat in full. Under Camelot a compact strip of the
 * members also stands under the header, lit on whoever speaks; under modern it stays collapsed.
 * `slot` is the element under the header the strip and the panel go into.
 */
export function GroupTable(props: {
	roomKey: string;
	slot?: HTMLElement | null | undefined;
}) {
	const view = useSelector((state) => state.rooms[props.roomKey]?.view);
	const look = useLook();
	const phone = useMedia("(max-width: 719px)");
	const [open, setOpen] = useState(false);
	if (!view || view.kind !== "group") return null;
	const members = view.members ?? [];
	const close = () => setOpen(false);
	const table = (
		<RoundTable
			members={members}
			groupRoom={props.roomKey}
			variant="full"
			list
		/>
	);
	return (
		<>
			<button
				type="button"
				className="icon-button group-table-button"
				aria-label={t("Table")}
				aria-expanded={open}
				aria-haspopup="dialog"
				onClick={() => setOpen((now) => !now)}
			>
				<Icon name="table" />
				<span className="group-table-label">{t("Table")}</span>
			</button>
			{look === "camelot"
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
			{phone ? (
				<Sheet open={open} title={t("Round table")} onClose={close}>
					<div className="group-table-body">{table}</div>
				</Sheet>
			) : open ? (
				placed(
					<aside className="group-table-panel" aria-label={t("Round table")}>
						<header>
							<h2>{t("Round table")}</h2>
							<button
								type="button"
								className="icon-button"
								aria-label={t("Close")}
								onClick={close}
							>
								<Icon name="close" />
							</button>
						</header>
						<div className="group-table-body">{table}</div>
					</aside>,
					props.slot,
				)
			) : null}
		</>
	);
}
