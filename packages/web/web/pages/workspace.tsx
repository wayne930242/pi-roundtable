import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	WorkspaceEntry,
	WorkspaceFileView,
	WorkspaceListView,
	WorkspaceReadOnlyReason,
	WorkspaceRootView,
	WorkspaceTrashItem,
} from "../../src/api-types.ts";
import { Confirm } from "../components/confirm.tsx";
import { Dialog } from "../components/dialog.tsx";
import { Icon } from "../components/icons.tsx";
import { Sheet } from "../components/sheet.tsx";
import { Badge, Empty, Failure, Loading } from "../components/states.tsx";
import { messageOf } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { size, when } from "../lib/format.ts";
import { useLeaveGuard } from "../lib/leave-guard.ts";
import { useMedia } from "../lib/media.ts";
import { translate as t, wording } from "../lib/messages.ts";
import { hrefFor, navigate, useRoute } from "../lib/router.ts";
import { toast } from "../lib/toast.ts";
import { conflictOf, rawHref, workspaceApi } from "../lib/workspace-api.ts";
import {
	join,
	type Place,
	parentOf,
	placeKey,
	placeOf,
	segmentsOf,
} from "../lib/workspace-place.ts";
import type { EditorHandle } from "../workspace/codeeditor.ts";
import { Glyph } from "../workspace/icons.tsx";

// The files pane: the roots the owner may see, a tree and breadcrumbs to move through them, a
// file shown with highlighting, and for a file that can be changed an editor with Save. The editor
// is a chunk of its own that loads when the first file opens.

const REASONS: Record<WorkspaceReadOnlyReason, string> = {
	"read-only-root": wording("this place is read-only"),
	"git-dir": wording("inside .git"),
	trash: wording("in the trash"),
	symlink: wording("a link"),
	binary: wording("binary file"),
	"too-large": wording("too large"),
	"not-utf8": wording("not UTF-8"),
};

/** A root's name as the pane shows it: the agents' two places are worded here, a host's own as given. */
function rootLabel(root: WorkspaceRootView): string {
	if (root.id === "agents") return t("Agents' workspace");
	if (root.id === "scratch") return t("Scratch");
	return root.label;
}

/** Folders that are listed but kept shut and dimmed: they are large and rarely what is wanted. */
const QUIET = new Set([".git", "node_modules"]);

const OPEN_KEY = (root: string) => `roundtable.workspace.open.${root}`;
const TREE_KEY = "roundtable.workspace.tree";
const WRAP_KEY = "roundtable.workspace.wrap";

function stored<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : (JSON.parse(raw) as T);
	} catch {
		return fallback;
	}
}
function keep(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Private browsing: the choice lasts for this page only.
	}
}

interface Shared {
	/** Changes when something was created, renamed, deleted or restored: lists fetch again. */
	rev: number;
	bump(): void;
}
const SharedContext = createContext<Shared>({ rev: 0, bump: () => undefined });

/** A directory's entries, fetched when it is shown, when something changed, and when the page regains focus. */
function useListing(root: string, path: string, enabled = true) {
	const { rev } = useContext(SharedContext);
	const [focus, setFocus] = useState(0);
	const [state, setState] = useState<{
		key: string;
		data?: WorkspaceListView;
		error?: string;
	}>({ key: "" });
	const key = `${root}:${path}`;
	useEffect(() => {
		const onFocus = () => setFocus((value) => value + 1);
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the counters say when to fetch
	useEffect(() => {
		if (!enabled) return;
		let current = true;
		workspaceApi.list(root, path).then(
			(data) => current && setState({ key, data }),
			(failure) => current && setState({ key, error: messageOf(failure) }),
		);
		return () => {
			current = false;
		};
	}, [root, path, enabled, rev, focus]);
	return state.key === key
		? { data: state.data, error: state.error }
		: { data: undefined, error: undefined };
}

const hrefOf = (place: Place) => hrefFor("workspace", placeKey(place));

/** What an entry opens: a file, a folder, or nothing (a link out of the root, a pipe). */
function entryTarget(
	root: string,
	dir: string,
	entry: WorkspaceEntry,
): Place | undefined {
	const path = join(dir, entry.name);
	if (entry.kind === "dir") return { root, path, dir: true };
	if (entry.kind === "file") return { root, path, dir: false };
	if (entry.kind === "symlink" && entry.inside)
		return { root, path, dir: entry.target === "dir" };
	return undefined;
}

function Breadcrumbs(props: { root: WorkspaceRootView; path: string }) {
	const parts = segmentsOf(props.path);
	const last = useRef<HTMLAnchorElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new place scrolls its last chip into view
	useEffect(() => {
		last.current?.scrollIntoView?.({ inline: "end", block: "nearest" });
	}, [props.path]);
	return (
		<nav className="ws-crumbs" aria-label={t("Path")}>
			<a
				ref={parts.length === 0 ? last : undefined}
				href={hrefOf({ root: props.root.id, path: "", dir: true })}
				aria-current={parts.length === 0 ? "page" : undefined}
			>
				{rootLabel(props.root)}
			</a>
			{parts.map((part, index) => {
				const path = parts.slice(0, index + 1).join("/");
				const leaf = index === parts.length - 1;
				return (
					<a
						key={path}
						ref={leaf ? last : undefined}
						href={hrefOf({ root: props.root.id, path, dir: true })}
						aria-current={leaf ? "page" : undefined}
					>
						{part}
					</a>
				);
			})}
		</nav>
	);
}

// ── The tree ───────────────────────────────────────────────────────────────────────────────────

function TreeDir(props: {
	root: string;
	path: string;
	depth: number;
	open: ReadonlySet<string>;
	toggle(path: string): void;
	current: Place | undefined;
}) {
	const { data, error } = useListing(props.root, props.path);
	if (error) return <p className="ws-tree-note">{error}</p>;
	if (!data) return <p className="ws-tree-note">…</p>;
	if (data.entries.length === 0)
		return <p className="ws-tree-note">{t("This folder is empty")}</p>;
	return (
		<ul className="ws-tree-list" data-depth={props.depth}>
			{data.entries.map((entry) => {
				const target = entryTarget(props.root, props.path, entry);
				const path = join(props.path, entry.name);
				const isDir = target?.dir === true;
				const expanded = isDir && props.open.has(path);
				const selected =
					props.current?.root === props.root &&
					props.current.path === path &&
					props.current.dir === isDir;
				return (
					<li key={entry.name}>
						<div
							className="ws-tree-row"
							data-selected={selected || undefined}
							data-quiet={QUIET.has(entry.name) || undefined}
							style={{ paddingLeft: `${0.25 + props.depth * 0.875}rem` }}
						>
							{isDir ? (
								<button
									type="button"
									className="ws-twist"
									aria-expanded={expanded}
									aria-label={t("Show or hide {name}", { name: entry.name })}
									onClick={() => props.toggle(path)}
								>
									<Icon name="chevron" size={14} />
								</button>
							) : (
								<span className="ws-twist" />
							)}
							{target ? (
								<a href={hrefOf(target)} title={entry.name}>
									<Glyph name={isDir ? "folder" : "file"} size={15} />
									<span className="ws-tree-label">{entry.name}</span>
								</a>
							) : (
								<span
									className="ws-tree-off"
									title={
										entry.inside === false ? t("Outside the workspace") : ""
									}
								>
									<Icon name="file" size={15} />
									<span className="ws-tree-label">{entry.name}</span>
								</span>
							)}
						</div>
						{expanded ? (
							<TreeDir
								root={props.root}
								path={path}
								depth={props.depth + 1}
								open={props.open}
								toggle={props.toggle}
								current={props.current}
							/>
						) : null}
					</li>
				);
			})}
			{data.truncated ? (
				<li className="ws-tree-note">
					{t("Only the first 2,000 items are listed")}
				</li>
			) : null}
		</ul>
	);
}

// ── A folder ───────────────────────────────────────────────────────────────────────────────────

function DirView(props: {
	root: WorkspaceRootView;
	path: string;
	onMenu(entry: WorkspaceEntry): void;
}) {
	const { data, error } = useListing(props.root.id, props.path);
	const { timeZone } = useConfig();
	if (error) return <Failure message={error} />;
	if (!data) return <Loading />;
	if (data.missing) return <Empty>{t("No files yet")}</Empty>;
	if (data.entries.length === 0)
		return <Empty>{t("This folder is empty")}</Empty>;
	return (
		<>
			<ul className="ws-rows">
				{data.entries.map((entry) => {
					const target = entryTarget(props.root.id, props.path, entry);
					const body = (
						<>
							<Glyph
								name={target?.dir ? "folder" : "file"}
								size={20}
								className="ws-row-icon"
							/>
							<span className="ws-row-main">
								<strong>{entry.name}</strong>
								<span className="meta">
									{entry.kind === "symlink" && entry.inside === false
										? t("Outside the workspace")
										: entry.kind === "other"
											? t("Not a regular file")
											: [
													target?.dir ? undefined : size(entry.size),
													when(new Date(entry.mtimeMs).toISOString(), timeZone),
												]
													.filter(Boolean)
													.join(" · ")}
								</span>
							</span>
						</>
					);
					return (
						<li
							key={entry.name}
							className="ws-row"
							data-quiet={QUIET.has(entry.name) || undefined}
						>
							{target ? (
								<a className="ws-row-link" href={hrefOf(target)}>
									{body}
								</a>
							) : (
								<span className="ws-row-link" data-off>
									{body}
								</span>
							)}
							{props.root.writable || target ? (
								<button
									type="button"
									className="icon-button"
									aria-label={t("Actions for {name}", { name: entry.name })}
									onClick={() => props.onMenu(entry)}
								>
									<Icon name="menu" />
								</button>
							) : null}
						</li>
					);
				})}
			</ul>
			{data.truncated ? (
				<p className="meta">{t("Only the first 2,000 items are listed")}</p>
			) : null}
		</>
	);
}

// ── A file ─────────────────────────────────────────────────────────────────────────────────────

type Mode = "read" | "edit";

function FileView(props: {
	root: WorkspaceRootView;
	path: string;
	phone: boolean;
}) {
	const { timeZone } = useConfig();
	const { bump } = useContext(SharedContext);
	const { root, path } = props;
	const [file, setFile] = useState<WorkspaceFileView>();
	const [error, setError] = useState<string>();
	const [mode, setMode] = useState<Mode>("read");
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [wrap, setWrap] = useState(() =>
		stored<boolean>(WRAP_KEY, props.phone),
	);
	const [menu, setMenu] = useState(false);
	const [ready, setReady] = useState(false);
	const [editorFailed, setEditorFailed] = useState(false);
	const [remote, setRemote] = useState<"changed" | "gone">();
	const [conflict, setConflict] = useState<{
		kind: "changed" | "gone";
		hash?: string;
		text: string;
	}>();
	const [overwrite, setOverwrite] = useState<{ hash: string; text: string }>();
	const host = useRef<HTMLDivElement>(null);
	const handle = useRef<EditorHandle | undefined>(undefined);
	const frame = useRef<HTMLDivElement>(null);
	const fileRef = useRef(file);
	fileRef.current = file;
	const modeRef = useRef(mode);
	modeRef.current = mode;

	const name = segmentsOf(path).at(-1) ?? path;
	const canText = file?.text !== undefined;

	const load = useCallback(async () => {
		const loaded = await workspaceApi.file(root.id, path);
		setFile(loaded);
		return loaded;
	}, [root.id, path]);

	useEffect(() => {
		let current = true;
		workspaceApi.file(root.id, path).then(
			(loaded) => current && setFile(loaded),
			(failure) => current && setError(messageOf(failure)),
		);
		return () => {
			current = false;
		};
	}, [root.id, path]);

	// Leaving with unsaved text asks first.
	const guard = useLeaveGuard(dirty, frame, () => {
		const current = fileRef.current;
		if (current?.text !== undefined)
			handle.current?.replace(current.text, current.eol);
		setDirty(false);
		setMode("read");
	});

	// The title says there is unsaved text.
	useEffect(() => {
		if (!dirty) return;
		const before = document.title;
		document.title = `• ${before}`;
		return () => {
			document.title = before;
		};
	}, [dirty]);

	const save = useCallback(
		async (baseHash?: string, text?: string) => {
			const current = fileRef.current;
			const editor = handle.current;
			if (!current || !editor || saving) return;
			const body = text ?? editor.text();
			setSaving(true);
			try {
				const saved = await workspaceApi.save(
					root.id,
					path,
					body,
					baseHash ?? current.hash,
				);
				editor.markSaved();
				setDirty(false);
				setRemote(undefined);
				setFile({
					...current,
					hash: saved.hash,
					size: saved.size,
					mtimeMs: saved.mtimeMs,
					text: body,
				});
				toast(t("Saved"));
				bump();
			} catch (failure) {
				const found = conflictOf(failure);
				if (found) {
					setConflict({
						kind: found.conflict === "gone" ? "gone" : "changed",
						...(found.current ? { hash: found.current.hash } : {}),
						text: body,
					});
				} else toast(messageOf(failure), "danger");
			} finally {
				setSaving(false);
			}
		},
		[root.id, path, saving, bump],
	);
	const saveRef = useRef(save);
	saveRef.current = save;

	/** Shows the file's current text again, whatever the editor holds. */
	const reload = useCallback(async () => {
		try {
			const loaded = await load();
			if (loaded.text !== undefined)
				handle.current?.replace(loaded.text, loaded.eol);
			setDirty(false);
			setRemote(undefined);
			setConflict(undefined);
		} catch (failure) {
			toast(messageOf(failure), "danger");
		}
	}, [load]);
	const reloadRef = useRef(reload);
	reloadRef.current = reload;

	const leaveEdit = useCallback(() => {
		if (handle.current?.dirty()) {
			setLeavingEdit(true);
			return;
		}
		setMode("read");
	}, []);
	const [leavingEdit, setLeavingEdit] = useState(false);
	const leaveEditRef = useRef(leaveEdit);
	leaveEditRef.current = leaveEdit;

	// The editor: its code loads the first time a file with text opens. It is made once per opened
	// file; the wrap and the mode are applied to it by the effects below.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		if (!canText || !host.current) return;
		const first = fileRef.current;
		if (!first || first.text === undefined) return;
		let cancelled = false;
		let created: EditorHandle | undefined;
		import("../workspace/codeeditor.ts")
			.then(async ({ createEditor }) => {
				if (cancelled || !host.current) return;
				const editor = await createEditor({
					parent: host.current,
					text: first.text ?? "",
					eol: first.eol,
					language: first.language,
					editable: false,
					wrap,
					phrases: {
						Find: t("Find"),
						Replace: t("Replace"),
						next: t("next"),
						previous: t("previous"),
						all: t("all"),
						"match case": t("match case"),
						regexp: t("regexp"),
						"by word": t("by word"),
						replace: t("replace"),
						"replace all": t("replace all"),
						close: t("close"),
					},
					onChange: () => setDirty(editor.dirty()),
					onSave: () => void saveRef.current(),
					onEscape: () => {
						if (modeRef.current === "edit") leaveEditRef.current();
					},
				});
				if (cancelled) {
					editor.destroy();
					return;
				}
				created = editor;
				handle.current = editor;
				setReady(true);
			})
			.catch((failure) => {
				console.warn("the editor failed to load", failure);
				if (!cancelled) setEditorFailed(true);
			});
		return () => {
			cancelled = true;
			created?.destroy();
			handle.current = undefined;
			setReady(false);
		};
	}, [canText, root.id, path]);

	useEffect(() => {
		if (!ready) return;
		const editable = mode === "edit" && file?.editable === true;
		handle.current?.setEditable(editable);
		if (editable) handle.current?.focus();
	}, [mode, ready, file?.editable]);

	useEffect(() => {
		if (!ready) return;
		handle.current?.setWrap(wrap);
		keep(WRAP_KEY, wrap);
	}, [wrap, ready]);

	// A partner may change the file while it is open: look again on focus and every few seconds.
	const opened = file !== undefined;
	useEffect(() => {
		if (!opened) return;
		let busy = false;
		const check = async () => {
			if (busy || document.visibilityState === "hidden") return;
			const shown = fileRef.current;
			if (!shown) return;
			busy = true;
			try {
				const listing = await workspaceApi.list(root.id, parentOf(path));
				const entry = listing.entries.find((one) => one.name === name);
				if (!entry) {
					setRemote("gone");
					return;
				}
				// A link's own times say nothing about its target's.
				if (entry.kind === "symlink") return;
				if (entry.size === shown.size && entry.mtimeMs === shown.mtimeMs)
					return;
				if (modeRef.current === "edit" && handle.current?.dirty()) {
					setRemote("changed");
					return;
				}
				const loaded = await workspaceApi.file(root.id, path);
				if (loaded.hash !== shown.hash) {
					setFile(loaded);
					if (loaded.text !== undefined)
						handle.current?.replace(loaded.text, loaded.eol);
				}
				setRemote(undefined);
			} catch {
				// A failed look is tried again at the next one.
			} finally {
				busy = false;
			}
		};
		const timer = setInterval(() => void check(), 5000);
		const onFocus = () => void check();
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onFocus);
		return () => {
			clearInterval(timer);
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onFocus);
		};
	}, [opened, root.id, path, name]);

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
				<button type="button" onClick={() => setMode("edit")}>
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
						{size(file.size)} ·{" "}
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
							: t("A partner is changing this file")}
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
				{file.image ? (
					<div className="ws-image">
						<img
							src={rawHref(root.id, path)}
							alt={name}
							width={undefined}
							height={undefined}
						/>
					</div>
				) : canText ? (
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
					<div className="card ws-card">
						<p>
							{file.tooLarge
								? t("This file is too large to show here.")
								: t("This file is not text, so it cannot be shown here.")}
						</p>
						<a
							className="button-link"
							href={rawHref(root.id, path, true)}
							download={name}
						>
							<Icon name="download" size={18} />
							{t("Download")}
						</a>
					</div>
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
				title={t("Replace the partner's changes?")}
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
		</div>
	);
}

// ── Making, renaming, deleting, the trash ──────────────────────────────────────────────────────

type NameAsk =
	| { kind: "file" | "dir"; dir: string }
	| { kind: "rename"; path: string; name: string };

function NameDialog(props: {
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
				<input
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

function TrashDialog(props: {
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

// ── The page ───────────────────────────────────────────────────────────────────────────────────

export function WorkspacePage() {
	const route = useRoute();
	const phone = !useMedia("(min-width: 720px)");
	const [rev, setRev] = useState(0);
	const bump = useCallback(() => setRev((value) => value + 1), []);
	const shared = useMemo(() => ({ rev, bump }), [rev, bump]);
	const [roots, setRoots] = useState<WorkspaceRootView[]>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		workspaceApi.roots().then(
			(view) => setRoots(view.roots),
			(failure) => setError(messageOf(failure)),
		);
	}, []);
	const [treeWidth, setTreeWidth] = useState(() =>
		stored<number>(TREE_KEY, 280),
	);
	const [menuFor, setMenuFor] = useState<WorkspaceEntry>();
	const [ask, setAsk] = useState<NameAsk>();
	const [trash, setTrash] = useState(false);
	const [deleting, setDeleting] = useState<{ path: string; name: string }>();

	const requested = placeOf(route.key);
	const root =
		roots?.find((one) => one.id === requested?.root) ??
		(phone ? undefined : roots?.[0]);
	const place: Place | undefined = root
		? requested && requested.root === root.id
			? requested
			: { root: root.id, path: "", dir: true }
		: undefined;

	const rootId = root?.id;
	const placePath = place?.path;
	const placeIsDir = place?.dir;
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
	useEffect(() => {
		if (!rootId) return;
		setOpen(new Set(stored<string[]>(OPEN_KEY(rootId), [])));
	}, [rootId]);
	const toggle = useCallback(
		(path: string) => {
			if (!rootId) return;
			setOpen((current) => {
				const next = new Set(current);
				if (next.has(path)) next.delete(path);
				else next.add(path);
				keep(OPEN_KEY(rootId), [...next]);
				return next;
			});
		},
		[rootId],
	);
	// The folders on the way to the open place are open in the tree.
	useEffect(() => {
		if (!rootId || placePath === undefined || phone) return;
		const ways = segmentsOf(placeIsDir ? placePath : parentOf(placePath));
		const parents = ways.map((_, index) => ways.slice(0, index + 1).join("/"));
		setOpen((current) => {
			if (parents.every((one) => current.has(one))) return current;
			const next = new Set([...current, ...parents]);
			keep(OPEN_KEY(rootId), [...next]);
			return next;
		});
	}, [rootId, placePath, placeIsDir, phone]);

	if (error) return <Failure message={error} />;
	if (!roots) return <Loading />;
	if (roots.length === 0) return <Empty>{t("No files yet")}</Empty>;

	// A phone with no place chosen lists the roots.
	if (!root || !place)
		return (
			<SharedContext.Provider value={shared}>
				<div className="page ws-page">
					<header className="page-head">
						<h1>{t("Files")}</h1>
					</header>
					<ul className="more-list">
						{roots.map((one) => (
							<li key={one.id}>
								<a
									className="menu-item menu-link"
									href={hrefOf({ root: one.id, path: "", dir: true })}
								>
									<span className="menu-icon">
										<Glyph name="folder" />
									</span>
									<span className="menu-text">
										<strong>{rootLabel(one)}</strong>
										{one.writable ? null : (
											<span className="meta">{t("Read only")}</span>
										)}
									</span>
									<Icon name="chevron" size={16} />
								</a>
							</li>
						))}
					</ul>
				</div>
			</SharedContext.Provider>
		);

	const here = place.dir ? place.path : parentOf(place.path);
	const upPlace: Place =
		place.path === ""
			? { root: root.id, path: "", dir: true }
			: { root: root.id, path: parentOf(place.path), dir: true };

	const head = (
		<header className="ws-head">
			{phone ? (
				<a
					className="icon-button"
					aria-label={t("Back")}
					href={place.path === "" ? hrefFor("workspace") : hrefOf(upPlace)}
				>
					<Icon name="back" />
				</a>
			) : (
				<select
					className="ws-root-picker"
					aria-label={t("Place")}
					value={root.id}
					onChange={(event) =>
						navigate(
							"workspace",
							placeKey({ root: event.target.value, path: "", dir: true }),
						)
					}
				>
					{roots.map((one) => (
						<option key={one.id} value={one.id}>
							{rootLabel(one)}
						</option>
					))}
				</select>
			)}
			<Breadcrumbs root={root} path={place.path} />
			{root.writable ? (
				<div className="ws-head-actions">
					<button
						type="button"
						className="icon-button"
						aria-label={t("New file")}
						title={t("New file")}
						onClick={() => setAsk({ kind: "file", dir: here })}
					>
						<Glyph name="file-plus" />
					</button>
					<button
						type="button"
						className="icon-button"
						aria-label={t("New folder")}
						title={t("New folder")}
						onClick={() => setAsk({ kind: "dir", dir: here })}
					>
						<Glyph name="folder-plus" />
					</button>
					<button
						type="button"
						className="icon-button"
						aria-label={t("Trash")}
						title={t("Trash")}
						onClick={() => setTrash(true)}
					>
						<Icon name="trash" />
					</button>
				</div>
			) : null}
		</header>
	);

	const main = place.dir ? (
		<div className="ws-dir">
			<DirView
				root={root}
				path={place.path}
				onMenu={(entry) => setMenuFor(entry)}
			/>
		</div>
	) : (
		<FileView
			key={`${root.id}:${place.path}`}
			root={root}
			path={place.path}
			phone={phone}
		/>
	);

	const menuTarget = menuFor ? entryTarget(root.id, here, menuFor) : undefined;
	const menuPath = menuFor ? join(here, menuFor.name) : "";

	return (
		<SharedContext.Provider value={shared}>
			<div
				className="ws-page ws"
				data-wide={!phone || undefined}
				style={{ "--ws-tree": `${treeWidth}px` } as React.CSSProperties}
			>
				{head}
				<div className="ws-body">
					{!phone ? (
						<>
							<aside className="ws-tree" aria-label={t("Folders")}>
								<TreeDir
									root={root.id}
									path=""
									depth={0}
									open={open}
									toggle={toggle}
									current={place}
								/>
							</aside>
							<Resizer
								width={treeWidth}
								onChange={(width) => {
									setTreeWidth(width);
									keep(TREE_KEY, width);
								}}
							/>
						</>
					) : null}
					<section className="ws-main">{main}</section>
				</div>
			</div>

			<Sheet
				open={menuFor !== undefined}
				title={menuFor?.name ?? ""}
				onClose={() => setMenuFor(undefined)}
			>
				<ul className="more-list">
					{menuTarget && !menuTarget.dir ? (
						<li>
							<a
								className="menu-item menu-link"
								href={rawHref(root.id, menuPath, true)}
								download={menuFor?.name}
								onClick={() => setMenuFor(undefined)}
							>
								<span className="menu-icon">
									<Icon name="download" />
								</span>
								<span className="menu-text">
									<strong>{t("Download")}</strong>
								</span>
							</a>
						</li>
					) : null}
					{root.writable && menuFor ? (
						<>
							<li>
								<button
									type="button"
									className="menu-item"
									onClick={() => {
										setAsk({
											kind: "rename",
											path: menuPath,
											name: menuFor.name,
										});
										setMenuFor(undefined);
									}}
								>
									<span className="menu-icon">
										<Icon name="notes" />
									</span>
									<span className="menu-text">
										<strong>{t("Rename")}</strong>
									</span>
								</button>
							</li>
							<li>
								<button
									type="button"
									className="menu-item"
									onClick={() => {
										setDeleting({ path: menuPath, name: menuFor.name });
										setMenuFor(undefined);
									}}
								>
									<span className="menu-icon">
										<Icon name="trash" />
									</span>
									<span className="menu-text">
										<strong>{t("Delete")}</strong>
									</span>
								</button>
							</li>
						</>
					) : null}
				</ul>
			</Sheet>

			<NameDialog
				root={root}
				ask={ask}
				onClose={() => setAsk(undefined)}
				onDone={(made) => {
					setAsk(undefined);
					bump();
					if (made) navigate("workspace", placeKey(made));
				}}
			/>
			<TrashDialog root={root} open={trash} onClose={() => setTrash(false)} />
			<Confirm
				open={deleting !== undefined}
				title={t("Move to the trash?")}
				confirmLabel={t("Delete")}
				tone="danger"
				onClose={() => setDeleting(undefined)}
				onConfirm={async () => {
					if (!deleting) return;
					await workspaceApi.remove(root.id, deleting.path);
					toast(t("Moved to the trash"));
					bump();
					// A file that is open and was deleted gives way to its folder.
					if (
						!place.dir &&
						(place.path === deleting.path ||
							place.path.startsWith(`${deleting.path}/`))
					)
						navigate(
							"workspace",
							placeKey({
								root: root.id,
								path: parentOf(place.path),
								dir: true,
							}),
						);
				}}
			>
				<p>
					{t("“{name}” goes to the trash, where you can bring it back.", {
						name: deleting?.name ?? "",
					})}
				</p>
			</Confirm>
		</SharedContext.Provider>
	);
}

/** The drag handle between the tree and the file; arrow keys move it too. */
function Resizer(props: { width: number; onChange(width: number): void }) {
	const MIN = 180;
	const MAX = 560;
	const clamp = (value: number) => Math.min(MAX, Math.max(MIN, value));
	return (
		// biome-ignore lint/a11y/useSemanticElements: a splitter has no native element
		<div
			className="ws-resizer"
			role="separator"
			aria-orientation="vertical"
			aria-valuenow={props.width}
			aria-valuemin={MIN}
			aria-valuemax={MAX}
			aria-label={t("Resize the folder list")}
			tabIndex={0}
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft") props.onChange(clamp(props.width - 16));
				if (event.key === "ArrowRight") props.onChange(clamp(props.width + 16));
			}}
			onPointerDown={(event) => {
				const startX = event.clientX;
				const start = props.width;
				const target = event.currentTarget;
				target.setPointerCapture(event.pointerId);
				const move = (move: PointerEvent) =>
					props.onChange(clamp(start + move.clientX - startX));
				const up = () => {
					target.removeEventListener("pointermove", move);
					target.removeEventListener("pointerup", up);
				};
				target.addEventListener("pointermove", move);
				target.addEventListener("pointerup", up);
			}}
		/>
	);
}

export type { ReactNode };
