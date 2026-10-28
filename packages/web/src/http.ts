/** Fixed errors shared by console API adapters; request paths and upstream details stay private. */
export class ConsoleHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		/** A reason a host opted into showing; appended after the translated message. */
		readonly detail?: string,
	) {
		super(message);
	}
}
/** Text safe in element content and in a quoted attribute value. */
export const escapeHtml = (value: string): string =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("'", "&#39;");
export const json = (body: unknown, status = 200): Response =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });
