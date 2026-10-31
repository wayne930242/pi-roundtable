// The member list the composer opens while an `@` is being typed at a word start. These are its
// rules, apart from the lazy menu that draws them.

/** A member a message can name: `name` is the agent's, `displayName` is what `@` writes. */
export interface Mentionable {
	name: string;
	displayName: string;
}

/** The `@word` the caret ends: where its `@` stands and what is typed after it. */
export interface MentionTrigger {
	from: number;
	query: string;
}

/**
 * The `@word` that ends at the caret, when the `@` starts a word. A leading `@AI` is the room's
 * own shorthand (see `mention.ts`) and never opens the list.
 */
export function mentionTrigger(
	text: string,
	caret: number,
): MentionTrigger | undefined {
	const found = /(^|\s)@([^\s@]*)$/u.exec(text.slice(0, caret));
	if (!found) return undefined;
	const query = found[2] ?? "";
	const from = found.index + (found[1] ?? "").length;
	if (query.toLowerCase() === "ai" && text.slice(0, from).trim() === "")
		return undefined;
	return { from, query };
}

/** The members whose display name or name starts with the query, then those that hold it; group order within each. */
export function matchMembers<M extends Mentionable>(
	members: readonly M[],
	query: string,
): M[] {
	const wanted = query.toLowerCase();
	const labels = (m: M) => [m.displayName, m.name].map((x) => x.toLowerCase());
	const starts = members.filter((m) =>
		labels(m).some((label) => label.startsWith(wanted)),
	);
	const holds = members.filter(
		(m) =>
			!starts.includes(m) && labels(m).some((label) => label.includes(wanted)),
	);
	return [...starts, ...holds];
}
