import { useEffect, useId, useState } from "react";
import type { WorkspaceRootView } from "../../src/api-types.ts";
import { Dialog } from "../components/dialog.tsx";
import { TextField } from "../components/fields.tsx";
import { Failure } from "../components/states.tsx";
import { messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { toast } from "../lib/toast.ts";
import { conflictOf, workspaceApi } from "../lib/workspace-api.ts";
import { join, type Place, parentOf } from "../lib/workspace-place.ts";

export type NameAsk =
	| { kind: "file" | "dir"; dir: string }
	| { kind: "rename"; path: string; name: string };

export function NameDialog(props: {
	root: WorkspaceRootView;
	ask: NameAsk | undefined;
	onClose(): void;
	onDone(place?: Place): void;
}) {
	const { ask } = props;
	const [value, setValue] = useState("");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const id = useId();
	useEffect(() => {
		setValue(ask?.kind === "rename" ? ask.name : "");
		setError(undefined);
	}, [ask]);
	const title =
		ask?.kind === "rename"
			? t("Rename")
			: ask?.kind === "dir"
				? t("New folder")
				: t("New file");
	const submit = async (event: { preventDefault(): void }) => {
		event.preventDefault();
		if (!ask) return;
		const name = value.trim();
		if (!name || name.includes("/")) {
			setError(t("Use a name without slashes."));
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			if (ask.kind === "rename") {
				const to = join(parentOf(ask.path), name);
				await workspaceApi.rename(props.root.id, ask.path, to);
				toast(t("Renamed"));
				props.onDone();
			} else {
				const path = join(ask.dir, name);
				await workspaceApi.create(props.root.id, path, ask.kind);
				toast(t("Created"));
				props.onDone({ root: props.root.id, path, dir: ask.kind === "dir" });
			}
		} catch (failure) {
			const found = conflictOf(failure);
			setError(
				found?.conflict === "exists"
					? t("Something with that name is already there.")
					: messageOf(failure),
			);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={ask !== undefined} title={title} onClose={props.onClose}>
			<form className="stack" onSubmit={submit}>
				<label htmlFor={id}>{t("Name")}</label>
				<TextField
					id={id}
					value={value}
					autoComplete="off"
					autoCapitalize="off"
					spellCheck={false}
					onChange={(event) => setValue(event.target.value)}
				/>
				{error ? <Failure message={error} /> : null}
				<div className="actions">
					<button type="button" className="secondary" onClick={props.onClose}>
						{t("Cancel")}
					</button>
					<button type="submit" disabled={busy || !value.trim()}>
						{ask?.kind === "rename" ? t("Rename") : t("Create")}
					</button>
				</div>
			</form>
		</Dialog>
	);
}
