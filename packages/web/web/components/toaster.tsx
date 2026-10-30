import { useEffect } from "react";
import type { RefusalCode } from "../../src/api-types.ts";
import { store, useSelector } from "../lib/app-store.ts";
import { translate as t } from "../lib/messages.ts";
import { dismissToast, toast, useToasts } from "../lib/toast.ts";
import { Icon } from "./icons.tsx";

/** What a refusal of the server says to the person. */
function refusalText(code: RefusalCode): string {
	switch (code) {
		case "bad_frame":
			return t("The app could not read that. Reload the page and try again.");
		case "unknown_room":
			return t("That room is gone.");
		case "read_only":
			return t("This room is read-only.");
		case "forbidden":
			return t("Only an owner can do that.");
		case "unknown_prompt":
			return t("That card is no longer open.");
		case "unknown_upload":
			return t("A file is no longer available. Attach it again.");
		case "empty":
			return t("Write a message or attach a file.");
		case "too_long":
			return t("That message is too long.");
		case "not_accepted":
			return t(
				"The message was not taken. Check the connection and try again.",
			);
		case "gated":
			return t("Finish setting up first.");
	}
}

/** Shows the notices, and turns a refusal the server sends into one. */
export function Toaster() {
	const toasts = useToasts();
	const refusal = useSelector((state) => state.refusal);
	useEffect(() => {
		if (!refusal) return;
		toast(refusalText(refusal), "danger");
		store.dispatch({ type: "refusal_dismissed" });
	}, [refusal]);
	return (
		<div className="toaster" role="status" aria-live="polite">
			{toasts.map((one) => (
				<div key={one.id} className="toast" data-tone={one.tone}>
					<span>{one.text}</span>
					{one.action ? (
						<button
							type="button"
							className="secondary toast-action"
							onClick={() => {
								dismissToast(one.id);
								one.action?.run();
							}}
						>
							{one.action.label}
						</button>
					) : null}
					<button
						type="button"
						className="icon-button"
						aria-label={t("Dismiss")}
						onClick={() => dismissToast(one.id)}
					>
						<Icon name="close" size={16} />
					</button>
				</div>
			))}
		</div>
	);
}
