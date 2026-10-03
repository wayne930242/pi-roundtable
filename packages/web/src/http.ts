/** Fixed errors shared by console API adapters; request paths and upstream details stay private. */
export class ConsoleHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
export const json = (body: unknown, status = 200): Response =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });
