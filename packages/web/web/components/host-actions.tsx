import { useState } from "react";
import type { FormInput, HostActionView } from "../../src/api-types.ts";
import type { HostActionResult } from "../../src/host/views.ts";
import { messageOf } from "../lib/api.ts";
import { openTarget } from "../lib/host-api.ts";
import { translate as t } from "../lib/messages.ts";
import { toast } from "../lib/toast.ts";
import { Confirm } from "./confirm.tsx";
import { Dialog } from "./dialog.tsx";
import { HostForm } from "./host-form.tsx";

/** Runs one action of a host room or page; the host decides what it means. */
export type RunAction = (
	action: HostActionView,
	input: FormInput,
) => Promise<HostActionResult>;

/**
 * What the person is told and shown after an action: a notice becomes a toast, and where the host
 * sends them is opened. A refusal returns its text, for the form (or the toast) to show.
 */
function finish(result: HostActionResult): { error: string; field?: string } | undefined {
	if (!result.ok)
		return {
			error: result.error,
			...(result.field ? { field: result.field } : {}),
		};
	if (result.notice) toast(result.notice);
	if (result.open) openTarget(result.open);
	return undefined;
}

/**
 * The buttons of an action list. An action with a `confirm` asks first; one with a `form` opens it;
 * the rest run at once. While one runs the buttons wait, and a refusal shows as a notice.
 */
export function HostActions(props: {
	actions: readonly HostActionView[];
	run: RunAction;
	className?: string;
}) {
	const [asking, setAsking] = useState<HostActionView>();
	const [busy, setBusy] = useState(false);
	const go = async (action: HostActionView, input: FormInput) => {
		const failed = finish(await props.run(action, input));
		return failed;
	};
	const press = async (action: HostActionView) => {
		if (action.form || action.confirm) {
			setAsking(action);
			return;
		}
		setBusy(true);
		try {
			const failed = await go(action, {});
			if (failed) toast(failed.error, "danger");
		} catch (failure) {
			toast(messageOf(failure), "danger");
		} finally {
			setBusy(false);
		}
	};
	if (props.actions.length === 0) return null;
	return (
		<div className={props.className ?? "host-actions"}>
			{props.actions.map((action) => (
				<button
					key={action.id}
					type="button"
					className={
						action.style === "danger"
							? "danger"
							: action.style === "secondary"
								? "secondary"
								: ""
					}
					disabled={busy}
					onClick={() => press(action)}
				>
					{action.label}
				</button>
			))}
			{asking?.form ? (
				<Dialog
					open
					title={asking.form.title}
					onClose={() => setAsking(undefined)}
				>
					<HostForm
						spec={asking.form}
						onCancel={() => setAsking(undefined)}
						onSubmit={async (input) => {
							const failed = await go(asking, input);
							if (!failed) setAsking(undefined);
							return failed;
						}}
					/>
				</Dialog>
			) : asking ? (
				<Confirm
					open
					title={asking.label}
					confirmLabel={asking.label}
					tone={asking.style === "danger" ? "danger" : "primary"}
					onConfirm={async () => {
						const failed = await go(asking, {});
						if (failed) throw new Error(failed.error);
					}}
					onClose={() => setAsking(undefined)}
				>
					<p>{asking.confirm}</p>
				</Confirm>
			) : null}
		</div>
	);
}
