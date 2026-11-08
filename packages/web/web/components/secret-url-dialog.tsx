import { translate as t } from "../lib/messages.ts";
import { toast } from "../lib/toast.ts";
import { Dialog } from "./dialog.tsx";

/** A secret URL, shown this once with a copy button: what it is for and that it is not shown again is `note`. */
export function SecretUrlDialog(props: {
	shown?: { title: string; note: string; label: string; url: string };
	onClose(): void;
}) {
	const { shown } = props;
	return (
		<Dialog
			open={shown !== undefined}
			title={shown?.title ?? ""}
			onClose={props.onClose}
		>
			<div className="stack">
				<p>{shown?.note}</p>
				<input
					readOnly
					aria-label={shown?.label}
					className="mcp-url"
					value={shown?.url ?? ""}
					onFocus={(e) => e.target.select()}
				/>
				<div className="actions">
					<button
						type="button"
						className="secondary"
						onClick={() => {
							void navigator.clipboard
								?.writeText(shown?.url ?? "")
								.then(() => toast(t("Copied")));
						}}
					>
						{t("Copy")}
					</button>
					<button type="button" onClick={props.onClose}>
						{t("Done")}
					</button>
				</div>
			</div>
		</Dialog>
	);
}
