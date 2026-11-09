import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type {
	WorkspaceFileView,
	WorkspaceRootView,
} from "../../src/api-types.ts";
import { messageOf } from "../lib/api.ts";
import { useLeaveGuard } from "../lib/leave-guard.ts";
import { translate as t } from "../lib/messages.ts";
import { toast } from "../lib/toast.ts";
import { conflictOf, workspaceApi } from "../lib/workspace-api.ts";
import { parentOf, segmentsOf } from "../lib/workspace-place.ts";
import type { EditorHandle } from "./codeeditor.ts";
import { keep, SharedContext, stored, WRAP_KEY } from "./shared.ts";

export type Mode = "read" | "edit";

/** The state of an open file: its text, the editor made for it, saving, and what changed under it. */
export function useFileState(props: {
	root: WorkspaceRootView;
	path: string;
	phone: boolean;
}) {
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
	/** What the preview learned from the file (a picture's size in pixels), for the header. */
	const [facts, setFacts] = useState<string>();
	/** A SVG is a picture first; its source is text the editor takes. */
	const [source, setSource] = useState(false);
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
	/** The editor stands where there is text and no preview takes its place. */
	const showEditor = canText && (file?.media === undefined || source);

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
			// What is sent is what is marked saved: keys typed while the request is out stay unsaved.
			const sent = text === undefined ? editor.snapshot() : undefined;
			const body = text ?? editor.text();
			setSaving(true);
			try {
				const saved = await workspaceApi.save(
					root.id,
					path,
					body,
					baseHash ?? current.hash,
				);
				editor.markSaved(sent);
				setDirty(editor.dirty());
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
		if (!showEditor || !host.current) return;
		const first = fileRef.current;
		if (!first || first.text === undefined) return;
		let cancelled = false;
		let created: EditorHandle | undefined;
		import("./codeeditor.ts")
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
					// Ctrl+S saves what has changed; in read mode, or with nothing changed, it writes nothing.
					onSave: () => {
						if (modeRef.current === "edit" && editor.dirty())
							void saveRef.current();
					},
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
	}, [showEditor, root.id, path]);

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

	return {
		file,
		error,
		mode,
		setMode,
		dirty,
		setDirty,
		saving,
		wrap,
		setWrap,
		menu,
		setMenu,
		facts,
		setFacts,
		source,
		setSource,
		ready,
		editorFailed,
		remote,
		setRemote,
		conflict,
		setConflict,
		overwrite,
		setOverwrite,
		leavingEdit,
		setLeavingEdit,
		host,
		handle,
		frame,
		name,
		canText,
		showEditor,
		guard,
		save,
		reload,
		leaveEdit,
		bump,
	};
}
