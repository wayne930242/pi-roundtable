import { readLimited } from "../request-body.ts";

/** The largest JSON body a write reads: 64 KiB. */
export const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export const bad = (message: string) => new HttpError(400, message);
export const notFound = () =>
	new HttpError(404, "There is no such room, knight or file.");

export async function bodyOf(
	request: Request,
	limit = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
	const raw = await readLimited(request, limit);
	if (!raw) throw new HttpError(413, "The body is too large.");
	let value: unknown;
	try {
		value = JSON.parse(raw.toString("utf8"));
	} catch {
		throw bad("The body is not JSON.");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw bad("The body is not an object.");
	return value as Record<string, unknown>;
}

export const optionalText = (
	body: Record<string, unknown>,
	key: string,
): string | undefined => {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw bad(`${key} must be text.`);
	return value;
};

export const requiredText = (
	body: Record<string, unknown>,
	key: string,
): string => {
	const value = body[key];
	if (typeof value !== "string" || value.trim() === "")
		throw bad(`${key} must be text.`);
	return value;
};

/** A list of text, or undefined when the body does not name it. */
export const optionalList = (
	body: Record<string, unknown>,
	key: string,
): string[] | undefined => {
	const value = body[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((one) => typeof one !== "string"))
		throw bad(`${key} must be a list of text.`);
	return value as string[];
};
