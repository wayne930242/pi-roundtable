import { type ReactNode, useEffect, useRef } from "react";
import { translate as t } from "../lib/messages.ts";

/** A modal built on the browser's own `<dialog>`: focus stays inside it and Escape closes it. */
export function Dialog(props: {
	open: boolean;
	title: string;
	onClose(): void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const { open } = props;
	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	}, [open]);
	return (
		<dialog ref={ref} onClose={props.onClose} aria-label={props.title}>
			<div className="stack">
				<div className="card-head">
					<h2>{props.title}</h2>
					<button
						type="button"
						className="secondary"
						aria-label={t("Close")}
						onClick={props.onClose}
					>
						{t("Close")}
					</button>
				</div>
				{props.open ? props.children : null}
			</div>
		</dialog>
	);
}
