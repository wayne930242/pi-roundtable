import type { MemoryKind } from "pi-roundtable";
import { SYSTEM_PRINCIPAL } from "pi-roundtable";
import type { NoteInput, NoteView, PrincipalsView } from "./api-types.ts";
import { readBody } from "./console-body.ts";
import type { ConsolePorts } from "./console-ports.ts";
import { ConsoleHttpError as HttpError, json } from "./http.ts";
import type { Visitor } from "./visitors.ts";

const NOTE_SEARCH_LIMIT = 500;

/** The notes pane: whose notes there are to choose from, and a person's notes read and written. */
export class NotesApi {
	readonly #ports: ConsolePorts;

	constructor(ports: ConsolePorts) {
		this.#ports = ports;
	}

	/** The people whose notes the pane can show: every principal but the host's own, the visitor first. */
	async principals(visitor: Visitor): Promise<PrincipalsView> {
		const self = visitor.principal.id;
		// Anyone but an owner has their own notes and no one else's to choose from.
		if (visitor.tier !== "owner")
			return {
				self,
				principals: [{ id: self, name: visitor.principal.displayName }],
			};
		const everyone = (await this.#ports.people?.list()) ?? [visitor.principal];
		const listed = [
			...everyone.filter((p) => p.id === self),
			...everyone.filter((p) => p.id !== self && p.id !== SYSTEM_PRINCIPAL),
		];
		return {
			self,
			principals: listed.map((p) => ({
				id: p.id,
				name: p.displayName,
				...(p.disabled ? { disabled: true as const } : {}),
			})),
		};
	}

	/** The memory of the principal the request names, default the visitor's own. */
	async #memoryFor(request: Request, visitor: Visitor) {
		const { memoryOf, people } = this.#ports;
		if (!memoryOf) throw new HttpError(404, "This pane is not served.");
		const named = new URL(request.url).searchParams.get("principal");
		if (named === null || named === visitor.principal.id)
			return memoryOf(visitor.principal.id);
		// Another person's notes are the owners' to read.
		if (visitor.tier !== "owner")
			throw new HttpError(403, "Only an owner may do this.");
		// The host's own principal keeps no notes; anyone else must be a principal the host knows.
		if (named === SYSTEM_PRINCIPAL || !(await people?.principal(named)))
			throw new HttpError(404, "There is no such person.");
		return memoryOf(named);
	}

	async notes(
		request: Request,
		id: string | undefined,
		visitor: Visitor,
	): Promise<Response> {
		const memory = await this.#memoryFor(request, visitor);
		const method = request.method;
		if (!id) {
			if (method === "GET") {
				const query = new URL(request.url).searchParams.get("q")?.trim();
				const notes: NoteView[] = query
					? await memory.search(query, NOTE_SEARCH_LIMIT)
					: await memory.list();
				return json(notes);
			}
			if (method === "POST") {
				const input = await noteInput(request);
				const added = await memory.add(input.fact, input.kind, input.eventDate);
				this.#ports.changed();
				return json(added, 201);
			}
		} else {
			const noteId = Number(id);
			if (!Number.isSafeInteger(noteId))
				throw new HttpError(404, "There is no such note.");
			if (method === "PATCH") {
				const updated = await memory.update(noteId, await noteInput(request));
				if (!updated) throw new HttpError(404, "There is no such note.");
				this.#ports.changed();
				return json(updated);
			}
			if (method === "DELETE") {
				if (!(await memory.removeById(noteId)))
					throw new HttpError(404, "There is no such note.");
				this.#ports.changed();
				return json({ deleted: noteId });
			}
		}
		throw new HttpError(405, "This method is not supported.");
	}
}

async function noteInput(request: Request): Promise<{
	fact: string;
	kind: MemoryKind;
	eventDate?: string;
}> {
	const body = await readBody(request);
	if (typeof body !== "object" || body === null)
		throw new HttpError(400, "The body is not valid.");
	const { fact, kind, eventDate } = body as Partial<NoteInput>;
	if (typeof fact !== "string" || typeof kind !== "string")
		throw new HttpError(400, "The body is not valid.");
	if (eventDate !== undefined && typeof eventDate !== "string")
		throw new HttpError(400, "The date is not valid.");
	return {
		fact,
		kind: kind as MemoryKind,
		...(eventDate ? { eventDate } : {}),
	};
}
