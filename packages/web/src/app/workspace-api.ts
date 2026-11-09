import type { Speaker } from "pi-roundtable";
import type {
	WorkspaceConflict,
	WorkspaceNew,
	WorkspaceRefusalBody,
	WorkspaceRename,
	WorkspaceRootsView,
	WorkspaceSave,
} from "../api-types.ts";
import type { Authenticated } from "../auth/authenticator.ts";
import { json } from "../http.ts";
import { bad, bodyOf, HttpError } from "./api-http.ts";
import type { AppApiOptions } from "./routes-options.ts";
import {
	EDIT_MAX_BYTES,
	WorkspaceConflictError,
	type WorkspaceFiles,
	WorkspaceRefusal,
} from "./workspace-files.ts";

/** A refusal of the workspace pane as the HTTP error the owner reads. */
function refusalOf(refusal: WorkspaceRefusal): HttpError {
	const { status } = refusal;
	switch (refusal.reason) {
		case "bad-path":
			return new HttpError(status, "That path is not allowed.");
		case "unknown-root":
			return new HttpError(status, "There is no such place.");
		case "not-found":
			return new HttpError(status, "There is no such file or folder.");
		case "not-a-dir":
			return new HttpError(status, "That is not a folder.");
		case "is-a-dir":
			return new HttpError(status, "That is a folder, not a file.");
		case "is-root":
			return new HttpError(
				status,
				"That is the top folder, which cannot be changed.",
			);
		case "outside":
			return new HttpError(status, "That points outside the workspace.");
		case "special":
			return new HttpError(status, "That is not a regular file.");
		case "symlink":
			return new HttpError(
				status,
				"That is a link; open the file it points to.",
			);
		case "read-only-root":
			return new HttpError(status, "This place is read-only.");
		case "git-dir":
			return new HttpError(status, "Files inside .git are read-only.");
		case "trash-dir":
			return new HttpError(status, "The trash cannot be changed this way.");
		case "binary":
			return new HttpError(
				status,
				"This file is not text, so it cannot be edited.",
			);
		case "not-utf8":
			return new HttpError(
				status,
				"This file is not UTF-8 text, so it cannot be edited.",
			);
		case "too-large":
			return new HttpError(status, "This file is too large.");
		case "text-too-large":
			return new HttpError(
				status,
				"The text is too large to save (1 MiB at most).",
			);
		case "into-itself":
			return new HttpError(status, "A folder cannot be moved into itself.");
		case "cross-device":
			return new HttpError(status, "That cannot be moved to another disk.");
		case "permission":
			return new HttpError(status, "The server is not allowed to change that.");
	}
}

/** A conflict of the workspace pane as the HTTP error the owner reads. */
function conflictOf(conflict: WorkspaceConflictError): HttpError {
	switch (conflict.conflict) {
		case "changed":
			return new HttpError(409, "This file changed while you were editing.");
		case "gone":
			return new HttpError(409, "This file is gone.");
		case "exists":
			return new HttpError(409, "Something with that name is already there.");
	}
}

/** The workspace files pane's API; every call, a read too, is an owner's. */
export class WorkspaceApi {
	readonly #workspace: AppApiOptions["workspace"];
	readonly #owner: (admission: Authenticated) => Promise<Speaker>;

	constructor(
		workspace: AppApiOptions["workspace"],
		owner: (admission: Authenticated) => Promise<Speaker>,
	) {
		this.#workspace = workspace;
		this.#owner = owner;
	}

	async handle(
		request: Request,
		parts: string[],
		admission: Authenticated,
	): Promise<Response> {
		const files = this.#workspace;
		if (!files) throw new HttpError(404, "This pane is not served.");
		const owner = await this.#owner(admission);
		return files.speaking(owner.id, () =>
			this.#workspaceCall(request, parts, files, owner.id),
		);
	}

	async #workspaceCall(
		request: Request,
		parts: string[],
		files: WorkspaceFiles,
		by: string,
	): Promise<Response> {
		const { method } = request;
		const [, , rootId, action, trashId, trashAction] = parts;
		const params = new URL(request.url).searchParams;
		const path = params.get("path") ?? "";
		try {
			if (!rootId) {
				if (method !== "GET") throw new HttpError(405, "Method not allowed.");
				return json({ roots: files.roots() } satisfies WorkspaceRootsView);
			}
			if (action === "list" && method === "GET" && parts.length === 4)
				return json(await files.list(rootId, path));
			if (action === "raw" && method === "GET" && parts.length === 4)
				return await files.raw(rootId, path, params.get("download") === "1", {
					range: request.headers.get("range"),
					ifRange: request.headers.get("if-range"),
					ifNoneMatch: request.headers.get("if-none-match"),
				});
			if (action === "file" && parts.length === 4) {
				if (method === "GET") return json(await files.read(rootId, path));
				if (method === "PUT") {
					const body = await bodyOf(request, EDIT_MAX_BYTES * 2 + 4096);
					const { text, baseHash } = body;
					if (typeof text !== "string") throw bad("text must be text.");
					if (typeof baseHash !== "string" || !/^[0-9a-f]{64}$/.test(baseHash))
						throw bad("baseHash must be the hash the file was read with.");
					const save: WorkspaceSave = { text, baseHash };
					return json(await files.save(rootId, path, save, by));
				}
			}
			if (action === "new" && method === "POST" && parts.length === 4) {
				const body = await bodyOf(request, EDIT_MAX_BYTES * 2 + 4096);
				const { kind, text } = body;
				if (kind !== "file" && kind !== "dir")
					throw bad("kind must be file or dir.");
				if (text !== undefined && typeof text !== "string")
					throw bad("text must be text.");
				const made: WorkspaceNew = {
					kind,
					...(text === undefined ? {} : { text }),
				};
				return json(await files.create(rootId, path, made, by), 201);
			}
			if (action === "rename" && method === "POST" && parts.length === 4) {
				const body = await bodyOf(request);
				const { from, to } = body;
				if (typeof from !== "string" || typeof to !== "string")
					throw bad("from and to must be paths.");
				const moved: WorkspaceRename = { from, to };
				await files.rename(rootId, moved.from, moved.to, by);
				return json({ ok: true });
			}
			if (action === "entry" && method === "DELETE" && parts.length === 4)
				return json(await files.remove(rootId, path, by));
			if (action === "trash") {
				if (method === "GET" && !trashId)
					return json(await files.trash(rootId));
				if (
					method === "POST" &&
					trashId &&
					trashAction === "restore" &&
					parts.length === 6
				)
					return json(await files.restore(rootId, trashId, by));
				if (method === "DELETE" && trashId && !trashAction) {
					await files.purge(rootId, trashId, by);
					return json({ ok: true });
				}
			}
		} catch (error) {
			if (error instanceof WorkspaceRefusal) {
				const refused = refusalOf(error);
				return json(
					{
						error: refused.message,
						reason: error.reason,
					} satisfies WorkspaceRefusalBody,
					refused.status,
				);
			}
			if (error instanceof WorkspaceConflictError) {
				const refused = conflictOf(error);
				return json(
					{
						error: refused.message,
						conflict: error.conflict,
						...(error.current ? { current: error.current } : {}),
					} satisfies WorkspaceConflict,
					409,
				);
			}
			throw error;
		}
		throw new HttpError(404, "There is no such API.");
	}
}
