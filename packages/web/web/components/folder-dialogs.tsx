import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { FOLDER_NAME_MAX, folderNameOf } from "../../src/layout-order.ts";
import {
	clearFolderDialog,
	type FolderDialog,
	useFolderDialog,
} from "../lib/folder-dialogs.ts";
import {
	createFolder,
	deleteFolder,
	moveRoom,
	renameFolderTo,
} from "../lib/layout-actions.ts";
import { translate as t } from "../lib/messages.ts";
import { Confirm } from "./confirm.tsx";
import { Dialog } from "./dialog.tsx";
import { MoveSheet } from "./move-sheet.tsx";

type NameAsk = Extract<FolderDialog, { kind: "new" | "rename" }>;

/** The name field of a new or renamed folder. It mounts when the sheet opens, so each time starts clean. */
function NameForm(props: { ask: NameAsk; onClose(): void }) {
	const { ask } = props;
	const [name, setName] = useState(ask.kind === "rename" ? ask.name : "");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const field = useRef<HTMLInputElement>(null);
	// The sheet's first control is its close button; the name is what the person came to type.
	useEffect(() => field.current?.focus(), []);
	const submit = async (event: SyntheticEvent) => {
		event.preventDefault();
		let clean: string;
		try {
			clean = folderNameOf(name);
		} catch {
			setError(t("Give the folder a name of 1 to 40 characters."));
			return;
		}
		setBusy(true);
		setError(undefined);
		let done: boolean;
		if (ask.kind === "rename")
			done = (await renameFolderTo(ask.id, clean, setError)) !== undefined;
		else {
			const id = await createFolder(clean, setError);
			done = id !== undefined;
			if (id && ask.room) await moveRoom(ask.room, id);
		}
		setBusy(false);
		if (done) props.onClose();
	};
	return (
		<form className="stack" onSubmit={submit}>
			<div className="field">
				<label className="field-label" htmlFor="folder-name">
					{t("Folder name")}
				</label>
				<input
					id="folder-name"
					type="text"
					ref={field}
					value={name}
					autoComplete="off"
					enterKeyHint="done"
					maxLength={FOLDER_NAME_MAX * 2}
					aria-invalid={error ? true : undefined}
					onChange={(event) => setName(event.target.value)}
				/>
				{error ? (
					<p className="field-error" role="alert">
						{error}
					</p>
				) : null}
			</div>
			<div className="actions">
				<button
					type="button"
					className="secondary"
					disabled={busy}
					onClick={props.onClose}
				>
					{t("Cancel")}
				</button>
				<button type="submit" disabled={busy}>
					{ask.kind === "rename" ? t("Rename") : t("Create")}
				</button>
			</div>
		</form>
	);
}

/** Draws the folder form, question or sheet that `askFolderDialog` asks for, wherever in the page it was asked. */
export function FolderDialogHost() {
	const ask = useFolderDialog();
	const last = useRef<FolderDialog | undefined>(undefined);
	if (ask) last.current = ask;
	const shown = last.current;
	if (!shown) return null;
	const named = shown.kind === "new" || shown.kind === "rename";
	return (
		<>
			{named ? (
				<Dialog
					open={ask?.kind === "new" || ask?.kind === "rename"}
					title={
						shown.kind === "rename" ? t("Rename folder") : t("Add a folder")
					}
					onClose={clearFolderDialog}
				>
					<NameForm ask={shown} onClose={clearFolderDialog} />
				</Dialog>
			) : null}
			{shown.kind === "delete" ? (
				<Confirm
					open={ask?.kind === "delete"}
					title={t("Delete folder")}
					confirmLabel={t("Delete folder")}
					tone="danger"
					onClose={clearFolderDialog}
					onConfirm={async () => {
						let refusal = "";
						const done = await deleteFolder(shown.id, (message) => {
							refusal = message;
						});
						if (!done) throw new Error(refusal);
					}}
				>
					<p>
						{t(
							"Delete the folder {name}? Its rooms move to Ungrouped; no room is deleted.",
							{ name: shown.name },
						)}
					</p>
				</Confirm>
			) : null}
			{shown.kind === "move" ? (
				<MoveSheet
					open={ask?.kind === "move"}
					room={shown.room}
					onClose={clearFolderDialog}
				/>
			) : null}
		</>
	);
}
