/** The longest text a webhook post puts in a room. */
export const MAX_POST_TEXT = 4000;
/** The longest author name a post may give itself. */
export const MAX_POST_AUTHOR = 80;

/** What a webhook's post shows in its room: its text, and the author it names, if any. */
export interface WebhookPost {
	text: string;
	author?: string;
}

const textField = (body: Record<string, unknown>): string | undefined => {
	for (const key of ["content", "text"]) {
		const value = body[key];
		if (
			typeof value === "string" &&
			value.trim() &&
			value.length <= MAX_POST_TEXT
		)
			return value;
	}
	return undefined;
};

/** A fence longer than any run of backticks in `text`, so the text cannot close it. */
function fenceFor(text: string): string {
	const longest = Math.max(
		2,
		...[...text.matchAll(/`+/g)].map((run) => run[0].length),
	);
	return "`".repeat(longest + 1);
}

/** The body pretty-printed in a fenced `json` block, cut to fit the room's limit. */
export function jsonBlock(body: unknown): string {
	const pretty = JSON.stringify(body, null, 2);
	const fence = fenceFor(pretty);
	const room = MAX_POST_TEXT - 2 * fence.length - "json\n\n".length;
	const cut =
		pretty.length <= room ? pretty : `${pretty.slice(0, room - 2)}\n…`;
	return `${fence}json\n${cut}\n${fence}`;
}

/**
 * What a post's JSON body shows: a Discord-shaped body (`content`, or `text`, with an optional
 * `username`) is its text by that author; any other object or array is shown as JSON. Undefined for
 * a body that is neither, such as a bare string or number.
 */
export function postOf(body: unknown): WebhookPost | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	if (!Array.isArray(body)) {
		const fields = body as Record<string, unknown>;
		const text = textField(fields);
		if (text !== undefined) {
			const { username } = fields;
			const author =
				typeof username === "string" &&
				username.trim() &&
				username.trim().length <= MAX_POST_AUTHOR
					? username.trim()
					: undefined;
			return author ? { text, author } : { text };
		}
	}
	return { text: jsonBlock(body) };
}
