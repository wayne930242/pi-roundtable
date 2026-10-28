import { type ReactNode, useState } from "react";
import { messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { Sheet } from "./sheet.tsx";
import { Failure } from "./states.tsx";

/** Asks before something that is hard to undo or changes what runs unattended; the answer is a sheet, not a browser box. */
export function Confirm(props: {
	open: boolean;
	title: string;
	confirmLabel: string;
	tone?: "danger" | "yolo" | "primary";
	/** Where focus goes when the sheet is gone, for a caller whose trigger is not in the page any more. */
	restoreFocus?(): HTMLElement | null;
	onConfirm(): Promise<void>;
	onClose(): void;
	children: ReactNode;
}) {
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string>();
	const close = () => {
		if (running) return;
		setError(undefined);
		props.onClose();
	};
	return (
		<Sheet
			open={props.open}
			title={props.title}
			onClose={close}
			{...(props.restoreFocus ? { restoreFocus: props.restoreFocus } : {})}
		>
			<div className="stack">
				<div className="prose">{props.children}</div>
				{error ? <Failure message={error} /> : null}
				<div className="actions">
					<button
						type="button"
						className="secondary"
						disabled={running}
						onClick={close}
					>
						{t("Cancel")}
					</button>
					<button
						type="button"
						className={
							props.tone === "danger"
								? "danger"
								: props.tone === "yolo"
									? "yolo-action"
									: ""
						}
						disabled={running}
						onClick={async () => {
							setRunning(true);
							setError(undefined);
							try {
								await props.onConfirm();
								props.onClose();
							} catch (failure) {
								setError(messageOf(failure));
							} finally {
								setRunning(false);
							}
						}}
					>
						{props.confirmLabel}
					</button>
				</div>
			</div>
		</Sheet>
	);
}
