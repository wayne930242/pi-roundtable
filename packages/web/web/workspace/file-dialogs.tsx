import type {
	WorkspaceFileView,
	WorkspaceRootView,
} from "../../src/api-types.ts";
import { Confirm } from "../components/confirm.tsx";
import { Dialog } from "../components/dialog.tsx";
import { Icon } from "../components/icons.tsx";
import { Sheet } from "../components/sheet.tsx";
import { messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { toast } from "../lib/toast.ts";
import { rawHref, workspaceApi } from "../lib/workspace-api.ts";
import type { useFileState } from "./file-state.ts";

/** The sheet and dialogs of an open file: its menu, a save that met a change, and the questions before edits are lost. */
export function FileDialogs(props: {
	root: WorkspaceRootView;
	path: string;
	file: WorkspaceFileView;
	state: ReturnType<typeof useFileState>;
}) {
	const { root, path, file, state } = props;
	const {
		name,
		canText,
		wrap,
		setWrap,
		menu,
		setMenu,
		conflict,
		setConflict,
		overwrite,
		setOverwrite,
		leavingEdit,
		setLeavingEdit,
		guard,
		handle,
		setDirty,
		setMode,
		reload,
		bump,
	} = state;
	return (
		<>
			<Sheet open={menu} title={name} onClose={() => setMenu(false)}>
				<div className="stack">
					<ul className="more-list">
						{canText ? (
							<li>
								<button
									type="button"
									className="menu-item"
									onClick={() => {
										setWrap((value) => !value);
										setMenu(false);
									}}
								>
									<span className="menu-text">
										<strong>
											{wrap ? t("Do not wrap lines") : t("Wrap lines")}
										</strong>
									</span>
								</button>
							</li>
						) : null}
						<li>
							<a
								className="menu-item menu-link"
								href={rawHref(root.id, path, true)}
								download={name}
								onClick={() => setMenu(false)}
							>
								<span className="menu-icon">
									<Icon name="download" />
								</span>
								<span className="menu-text">
									<strong>{t("Download")}</strong>
								</span>
							</a>
						</li>
						<li>
							<button
								type="button"
								className="menu-item"
								onClick={() => {
									setMenu(false);
									void reload();
								}}
							>
								<span className="menu-icon">
									<Icon name="refresh" />
								</span>
								<span className="menu-text">
									<strong>{t("Reload")}</strong>
								</span>
							</button>
						</li>
					</ul>
				</div>
			</Sheet>

			<Dialog
				open={conflict !== undefined}
				title={
					conflict?.kind === "gone"
						? t("This file is gone")
						: t("This file changed while you were editing")
				}
				onClose={() => setConflict(undefined)}
			>
				<div className="stack">
					<p>
						{conflict?.kind === "gone"
							? t("Someone deleted it. Your text has not been saved.")
							: t("Your text has not been saved. What should happen to it?")}
					</p>
					<div className="actions">
						<button
							type="button"
							className="secondary"
							onClick={() => {
								void navigator.clipboard
									?.writeText(conflict?.text ?? "")
									.then(() => toast(t("Copied")));
							}}
						>
							{t("Copy my text")}
						</button>
						{conflict?.kind === "changed" ? (
							<button
								type="button"
								className="secondary"
								onClick={() => void reload()}
							>
								{t("Reload (discard my edits)")}
							</button>
						) : null}
						<button
							type="button"
							className="danger"
							onClick={() => {
								if (!conflict) return;
								if (conflict.kind === "gone") {
									const text = conflict.text;
									setConflict(undefined);
									void workspaceApi
										.create(root.id, path, "file", text)
										.then(async () => {
											await reload();
											bump();
										})
										.catch((failure) => toast(messageOf(failure), "danger"));
									return;
								}
								setOverwrite({
									hash: conflict.hash ?? "",
									text: conflict.text,
								});
								setConflict(undefined);
							}}
						>
							{conflict?.kind === "gone"
								? t("Save mine as a new file")
								: t("Save mine anyway")}
						</button>
					</div>
				</div>
			</Dialog>

			<Confirm
				open={overwrite !== undefined}
				title={t("Replace the knight's changes?")}
				confirmLabel={t("Save mine anyway")}
				tone="danger"
				onClose={() => setOverwrite(undefined)}
				onConfirm={async () => {
					if (!overwrite) return;
					await workspaceApi.save(
						root.id,
						path,
						overwrite.text,
						overwrite.hash,
					);
					await reload();
					toast(t("Saved"));
					bump();
				}}
			>
				<p>
					{t(
						"The file has been changed since you opened it. Saving yours writes over those changes.",
					)}
				</p>
			</Confirm>

			<Confirm
				open={leavingEdit}
				title={t("Unsaved changes, leave?")}
				confirmLabel={t("Discard")}
				cancelLabel={t("Keep editing")}
				tone="danger"
				onClose={() => setLeavingEdit(false)}
				onConfirm={async () => {
					if (file.text !== undefined)
						handle.current?.replace(file.text, file.eol);
					setDirty(false);
					setMode("read");
				}}
			>
				<p>{t("Your edits to {name} have not been saved.", { name })}</p>
			</Confirm>

			<Confirm
				open={guard.leaving !== undefined}
				title={t("Unsaved changes, leave?")}
				confirmLabel={t("Discard")}
				cancelLabel={t("Keep editing")}
				tone="danger"
				onClose={guard.stay}
				onConfirm={async () => guard.leave()}
			>
				<p>{t("Your edits to {name} have not been saved.", { name })}</p>
			</Confirm>
		</>
	);
}
