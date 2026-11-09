import { ConsoleHttpError as HttpError } from "./http.ts";
import { readLimited } from "./request-body.ts";

/** The largest note body the console reads. */
const MAX_BODY_BYTES = 64 * 1024;

/** The JSON body; undefined when it is not JSON. */
export async function readBody(request: Request): Promise<unknown> {
	const raw = await readLimited(request, MAX_BODY_BYTES);
	if (!raw) throw new HttpError(413, "The request is too large.");
	try {
		return JSON.parse(raw.toString("utf8"));
	} catch {
		return undefined;
	}
}
