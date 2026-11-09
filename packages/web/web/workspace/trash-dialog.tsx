import { useContext, useEffect, useState } from "react";
import type {
	WorkspaceRootView,
	WorkspaceTrashItem,
} from "../../src/api-types.ts";
import { Confirm } from "../components/confirm.tsx";
import { Dialog } from "../components/dialog.tsx";
import { Icon } from "../components/icons.tsx";
import { Empty, Failure, Loading } from "../components/states.tsx";
import { messageOf } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { when } from "../lib/format.ts";
import { translate as t } from "../lib/messages.ts";
import { toast } from "../lib/toast.ts";
import { conflictOf, workspaceApi } from "../lib/workspace-api.ts";
import { Glyph } from "./icons.tsx";
import { SharedContext } from "./shared.ts";

export function TrashDialog(props: {
	root: WorkspaceRootView;
	open: boolean;
	onClose(): void;
}) {
	const { bump, rev } = useContext(SharedContext);
	const [items, setItems] = useState<WorkspaceTrashItem[]>();
	const [error, setError] = useState<string>();
	const [purging, setPurging] = useState<WorkspaceTrashItem>();
	const { timeZone } = useConfig();
	// biome-ignore lint/correctness/useExhaustiveDependencies: a change elsewhere refetches
	useEffect(() => {
		if (!props.open) return;
		let current = true;
		workspaceApi.trash(props.root.id).then(
			(view) => current && setItems(view.items),
			(failure) => current && setError(messageOf(failure)),
		);
		return () => {
			current = false;
		};
	}, [props.open, props.root.id, rev]);
	return (
		<Dialog open={props.open} title={t("Trash")} onClose={props.onClose}>
			<div className="stack">
				{error ? <Failure message={error} /> : null}
				{!items && !error ? <Loading /> : null}
				{items?.length === 0 ? <Empty>{t("The trash is empty")}</Empty> : null}
				<ul className="ws-rows">
					{items?.map((item) => (
						<li key={item.id} className="ws-row">
							<span className="ws-row-link" data-off>
								<Glyph
									name={item.kind === "dir" ? "folder" : "file"}
									size={20}
									className="ws-row-icon"
								/>
								<span className="ws-row-main">
									<strong>{item.path}</strong>
									<span className="meta">{when(item.deletedAt, timeZone)}</span>
								</span>
							</span>
							<button
								type="button"
								className="secondary"
								onClick={async () => {
									try {
										await workspaceApi.restore(props.root.id, item.id);
										toast(t("Restored"));
										bump();
									} catch (failure) {
										const found = conflictOf(failure);
										toast(
											found
												? found.conflict === "exists"
													? t("Something with that name is already there.")
													: t("The folder it was in is gone.")
												: messageOf(failure),
											"danger",
										);
									}
								}}
							>
								{t("Restore")}
							</button>
							<button
								type="button"
								className="icon-button danger-icon"
								aria-label={t("Delete {name} for good", { name: item.name })}
								onClick={() => setPurging(item)}
							>
								<Icon name="trash" />
							</button>
						</li>
					))}
				</ul>
			</div>
			<Confirm
				open={purging !== undefined}
				title={t("Delete for good?")}
				confirmLabel={t("Delete for good")}
				tone="danger"
				onClose={() => setPurging(undefined)}
				onConfirm={async () => {
					if (!purging) return;
					await workspaceApi.purge(props.root.id, purging.id);
					bump();
				}}
			>
				<p>
					{t("“{name}” will be removed and cannot be brought back.", {
						name: purging?.path ?? "",
					})}
				</p>
			</Confirm>
		</Dialog>
	);
}
