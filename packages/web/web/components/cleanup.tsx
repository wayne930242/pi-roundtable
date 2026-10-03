import { useState } from "react";
import { api, messageOf } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { translate as t } from "../lib/messages.ts";
import { Dialog } from "./dialog.tsx";
import { Failure } from "./states.tsx";

export function Cleanup(props: {
	channel: string;
	title: string;
	busy: boolean;
	deletable?: boolean;
	refresh(): void;
}) {
	const { cleanup } = useConfig();
	const [action, setAction] = useState<"start-over" | "delete">();
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string>();
	if (!cleanup) return null;
	const close = () => {
		if (!running) {
			setAction(undefined);
			setError(undefined);
		}
	};
	return (
		<div className="actions">
			<button
				type="button"
				className="secondary"
				onClick={() => setAction("start-over")}
			>
				{t("Start over")}
			</button>
			{props.deletable ? (
				<button
					type="button"
					className="danger"
					onClick={() => setAction("delete")}
				>
					{t("Delete")}
				</button>
			) : null}
			<Dialog
				open={action !== undefined}
				title={
					action === "delete"
						? t("Permanently delete {name}?", { name: props.title })
						: t("Start over {name}?", { name: props.title })
				}
				onClose={close}
			>
				<p>
					{action === "delete"
						? t(
								"The live conversation and all archives will be permanently deleted. Memory and schedules are preserved.",
							)
						: t(
								"The current conversation will be archived; the next message starts a new one. Long-term memory is preserved. Active turns finish first.",
							)}
				</p>
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
						className={action === "delete" ? "danger" : ""}
						disabled={running}
						onClick={async () => {
							if (!action) return;
							setRunning(true);
							setError(undefined);
							try {
								if (action === "delete")
									await api.deleteConversation(props.channel);
								else await api.startOver(props.channel);
								setAction(undefined);
								props.refresh();
							} catch (failure) {
								setError(messageOf(failure));
							} finally {
								setRunning(false);
							}
						}}
					>
						{running
							? action === "delete"
								? t("Deleting…")
								: props.busy
									? t("Waiting for this turn…")
									: t("Starting over…")
							: action === "delete"
								? t("Delete permanently")
								: t("Start over")}
					</button>
				</div>
			</Dialog>
		</div>
	);
}
