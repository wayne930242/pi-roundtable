import type {
	WorkspaceReadOnlyReason,
	WorkspaceRootView,
} from "../../src/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { Badge, Failure, Loading } from "../components/states.tsx";
import { useConfig } from "../lib/config.ts";
import { size, when } from "../lib/format.ts";
import { translate as t, wording } from "../lib/messages.ts";
import { FileDialogs } from "./file-dialogs.tsx";
import { useFileState } from "./file-state.ts";
import { FileCard, MediaPreview } from "./preview.tsx";

const REASONS: Record<WorkspaceReadOnlyReason, string> = {
	"read-only-root": wording("this place is read-only"),
	"git-dir": wording("inside .git"),
	trash: wording("in the trash"),
	symlink: wording("a link"),
	binary: wording("binary file"),
	"too-large": wording("too large"),
	"not-utf8": wording("not UTF-8"),
};

/** An open file: its header with the actions, the preview or editor, and the dialogs over them. */
export function FileView(props: {
	root: WorkspaceRootView;
	path: string;
	phone: boolean;
}) {
	const { timeZone } = useConfig();
	const { root, path } = props;
	const state = useFileState(props);
	const {
		file,
		error,
		mode,
		setMode,
		dirty,
		saving,
		setMenu,
		setFacts,
		facts,
		setSource,
		ready,
		editorFailed,
		remote,
		setRemote,
		host,
		frame,
		handle,
		name,
		showEditor,
		save,
		reload,
		leaveEdit,
	} = state;
	if (error)
		return (
			<div className="ws-file">
				<Failure message={error} />
			</div>
		);
	if (!file)
		return (
			<div className="ws-file">
				<Loading />
			</div>
		);

	const reason = file.reason;
	const readOnlyBadge = !file.editable ? (
		<Badge tone="warn">
			{t("Read only: {reason}", {
				reason: reason ? t(REASONS[reason]) : "",
			})}
		</Badge>
	) : null;
	const editing = mode === "edit";

	const actions = (
		<div className="ws-actions">
			{file.editable && !editing ? (
				<button
					type="button"
					onClick={() => {
						setSource(true);
						setMode("edit");
					}}
				>
					{t("Edit")}
				</button>
			) : null}
			{editing ? (
				<>
					<button
						type="button"
						disabled={saving || !dirty}
						onClick={() => void save()}
					>
						{t("Save")}
					</button>
					<button type="button" className="secondary" onClick={leaveEdit}>
						{t("Cancel")}
					</button>
				</>
			) : null}
			<button
				type="button"
				className="icon-button"
				aria-label={t("File menu")}
				onClick={() => setMenu(true)}
			>
				<Icon name="menu" />
			</button>
		</div>
	);

	return (
		<div className="ws-file" ref={frame}>
			<header className="ws-file-head">
				<div className="ws-file-title">
					<strong>
						{dirty ? "• " : ""}
						{name}
					</strong>
					<span className="meta">
						{size(file.size)}
						{facts ? ` · ${facts}` : ""} ·{" "}
						{when(new Date(file.mtimeMs).toISOString(), timeZone)}
					</span>
				</div>
				{readOnlyBadge}
				{actions}
			</header>
			{remote ? (
				<div className="ws-banner" role="status">
					<span className="ws-banner-text">
						{remote === "gone"
							? t("This file is gone")
							: t("A knight is changing this file")}
					</span>
					{remote === "changed" ? (
						<>
							<button
								type="button"
								className="secondary"
								onClick={() => void reload()}
							>
								{t("Reload (discard my edits)")}
							</button>
							<button
								type="button"
								className="secondary"
								onClick={() => setRemote(undefined)}
							>
								{t("Keep editing")}
							</button>
						</>
					) : null}
				</div>
			) : null}
			<div className="ws-view">
				{file.media && !showEditor ? (
					<MediaPreview
						media={file.media}
						root={root.id}
						path={path}
						name={name}
						bytes={file.size}
						phone={props.phone}
						onFacts={setFacts}
					/>
				) : showEditor ? (
					<div
						ref={host}
						className="ws-editor"
						data-editing={editing || undefined}
					>
						{!ready ? (
							<pre className="ws-plain" aria-busy={!editorFailed}>
								{file.text}
							</pre>
						) : null}
					</div>
				) : (
					<FileCard
						root={root.id}
						path={path}
						name={name}
						bytes={file.size}
						message={
							file.tooLarge
								? t("This file is too large to show here.")
								: t("This file is not text, so it cannot be shown here.")
						}
					/>
				)}
			</div>
			{props.phone && editing ? (
				<div className="ws-editbar" role="toolbar" aria-label={t("Editing")}>
					<button
						type="button"
						disabled={saving || !dirty}
						onClick={() => void save()}
					>
						{t("Save")}
					</button>
					<button
						type="button"
						className="secondary"
						onClick={() => handle.current?.undo()}
					>
						{t("Undo")}
					</button>
					<button
						type="button"
						className="secondary"
						onClick={() => handle.current?.redo()}
					>
						{t("Redo")}
					</button>
					<button
						type="button"
						className="secondary"
						onClick={() => handle.current?.find()}
					>
						{t("Find")}
					</button>
					<button
						type="button"
						className="secondary"
						onClick={() => handle.current?.tab()}
					>
						{t("Tab")}
					</button>
				</div>
			) : null}
			<FileDialogs root={root} path={path} file={file} state={state} />
		</div>
	);
}
