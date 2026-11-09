import type { Authenticated } from "../auth/authenticator.ts";
import { viewerOf } from "../web-app.ts";
import { HttpError, notFound } from "./api-http.ts";
import { fileResponse, isFileId } from "./files.ts";
import type { AppApiOptions } from "./routes-options.ts";
import { uniqueNames, zipStore } from "./zip.ts";

/** The most bytes a message's files may add up to and still be zipped together: 200 MB. */
const MAX_ZIP_BYTES = 200 * 1024 * 1024;

/** A message's zip, named after when it was sent on the host's clock: `attachments-20261031-2030.zip`. */
export const zipName = (at: Date, timeZone = "UTC"): string => {
	if (Number.isNaN(at.getTime())) return "attachments.zip";
	const part = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(at)
			.map(({ type, value }) => [type, value]),
	);
	return `attachments-${part.year}${part.month}${part.day}-${part.hour}${part.minute}.zip`;
};

/** The stored files: one by id, or all of a message's as a zip. */
export class FileApi {
	readonly #options: Pick<AppApiOptions, "files" | "host" | "log" | "timeZone">;

	constructor(
		options: Pick<AppApiOptions, "files" | "host" | "log" | "timeZone">,
	) {
		this.#options = options;
	}

	async file(
		id: string,
		admission: Authenticated,
		request: Request,
	): Promise<Response> {
		if (!isFileId(id)) throw notFound();
		await this.#mayServe(id, admission);
		const { files } = this.#options;
		const meta = files.meta(id);
		const blob = files.blob(id);
		if (!meta || !blob) throw notFound();
		return fileResponse(meta, blob, request.headers.get("sec-fetch-dest"));
	}

	/** Refuses, as a missing file, a stored file the visitor may not be served. */
	async #mayServe(id: string, admission: Authenticated): Promise<void> {
		const { files, host } = this.#options;
		// A file bound to a host room or page is for the people it is open to, owners too; every other stored file belongs to an agent room, which only owners read.
		const bound = files.binding(id)?.room;
		if (bound === undefined) {
			if (admission.visitor.tier !== "owner") throw notFound();
		} else if (
			!host ||
			!(await host.mayRead(viewerOf(admission.visitor), bound))
		)
			throw notFound();
	}

	/**
	 * `GET api/files/zip?room=<room>&message=<id>`: the message's files still kept, as one zip.
	 * The room and every file answer as the single file does; a refusal is a missing message.
	 */
	async messageZip(
		request: Request,
		admission: Authenticated,
	): Promise<Response> {
		const params = new URL(request.url).searchParams;
		const room = params.get("room") ?? "";
		const id = Number(params.get("message"));
		if (room === "" || !Number.isSafeInteger(id) || id <= 0) throw notFound();
		const { files, host, log } = this.#options;
		const mayReadRoom =
			admission.visitor.tier === "owner" ||
			(host !== undefined &&
				(await host.mayRead(viewerOf(admission.visitor), room)));
		if (!mayReadRoom) throw notFound();
		const message = await log.get(room, id);
		if (!message) throw notFound();
		// Only the files still kept: a swept file has no binding left to check it by.
		const kept = message.files.flatMap((file) => {
			const meta = isFileId(file.id) ? files.meta(file.id) : undefined;
			const blob = meta && files.blob(file.id);
			return meta && blob ? [{ id: file.id, meta, blob }] : [];
		});
		for (const file of kept) await this.#mayServe(file.id, admission);
		if (kept.length === 0)
			throw new HttpError(
				404,
				"None of this message's files are kept any more.",
			);
		const total = kept.reduce((sum, { blob }) => sum + blob.size, 0);
		if (total > MAX_ZIP_BYTES)
			throw new HttpError(
				413,
				"These files are too large to download together; download them one by one.",
			);
		const names = uniqueNames(kept.map(({ meta }) => meta.name));
		const entries = await Promise.all(
			kept.map(async ({ blob }, i) => ({
				name: names[i] ?? "file",
				data: new Uint8Array(await blob.arrayBuffer()),
			})),
		);
		const at = new Date(message.at);
		return new Response(zipStore(entries, at), {
			headers: {
				"content-type": "application/zip",
				"content-disposition": `attachment; filename="${zipName(at, this.#options.timeZone)}"`,
				"cache-control": "private, no-store",
				"x-content-type-options": "nosniff",
			},
		});
	}
}
