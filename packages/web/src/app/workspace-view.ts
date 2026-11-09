import type {
	WorkspaceFileView,
	WorkspaceReadOnlyReason,
} from "../api-types.ts";
import { classify, hashOf } from "./workspace-bytes.ts";
import type { Located, WorkspaceGuard } from "./workspace-guard.ts";
import { languageOf } from "./workspace-language.ts";
import { mediaOf } from "./workspace-media.ts";
import {
	EDIT_MAX_BYTES,
	HEAD_BYTES,
	isGitDir,
	isTrashDir,
	VIEW_MAX_BYTES,
	WorkspaceRefusal,
} from "./workspace-model.ts";

/** A file as the pane shows it: its text and flags, or the reason it is not editable. */
export async function readFileView(
	guard: WorkspaceGuard,
	rootId: string,
	raw: string,
): Promise<WorkspaceFileView> {
	const located = await guard.located(rootId, raw);
	const { root, segments } = located;
	const target = await guard.target(located, raw);
	if (target.info.isDirectory()) throw new WorkspaceRefusal(400, "is-a-dir");
	const handle = await guard.openRegular(
		target.path,
		target.info,
		root.id,
		raw,
	);
	try {
		const info = await handle.stat();
		const head = Buffer.alloc(Math.min(HEAD_BYTES, info.size));
		await handle.read(head, 0, head.length, 0);
		const name = segments.at(-1) ?? "";
		const media = mediaOf(name, head);
		const view: WorkspaceFileView = {
			path: raw,
			size: info.size,
			mtimeMs: info.mtimeMs,
			hash: "",
			editable: false,
			binary: false,
			tooLarge: info.size > VIEW_MAX_BYTES,
			eol: "\n",
			bom: false,
			language: languageOf(name),
			...(media ? { media: media.kind } : {}),
		};
		let reason = whyReadOnly(located, target.viaLink, raw);
		if (view.tooLarge) {
			view.binary = head.includes(0);
			view.reason = reason ?? (view.binary ? "binary" : "too-large");
			return view;
		}
		const bytes = await guard.readAll(handle, info.size, VIEW_MAX_BYTES);
		view.hash = hashOf(bytes);
		const kind = classify(bytes);
		view.binary = kind.binary;
		view.bom = kind.bom;
		view.eol = kind.eol;
		if (kind.text !== undefined) view.text = kind.text;
		reason ??= kind.binary
			? "binary"
			: kind.notUtf8
				? "not-utf8"
				: info.size > EDIT_MAX_BYTES
					? "too-large"
					: undefined;
		if (reason) view.reason = reason;
		else view.editable = true;
		return view;
	} finally {
		await handle.close();
	}
}

/** The structural reason a file is not editable, if there is one. */
function whyReadOnly(
	located: Located,
	viaLink: boolean,
	_raw: string,
): WorkspaceReadOnlyReason | undefined {
	const { root, segments } = located;
	if (viaLink) return "symlink";
	if (!root.writable) return "read-only-root";
	if (segments.some(isGitDir)) return "git-dir";
	if (isTrashDir(segments[0])) return "trash";
	return undefined;
}
