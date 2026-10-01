import type { Judge } from "../contract/providers.ts";
import { type OwnerIdentity, ownerWords } from "../identity.ts";
import type { Logger } from "../log.ts";
import type { Agent, GroupMessage } from "./agent-store.ts";

/** Members at or above this relevance answer an owner message nobody is named in. */
export const RELEVANCE_THRESHOLD = 0.5;
/** Replies one round may hold, handoffs included (spec behavior 29). */
export const MAX_ROUND_REPLIES = 8;
/** Group messages the scorer reads before the new one. */
export const RECENT_FOR_SCORING = 12;
const SCORING_TEXT_CHARS = 1_500;
const PROMPT_CHARS_FOR_SCORING = 1_200;

const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const mentions = (text: string, label: string) =>
	// The label is an agent's name, escaped so every character of it matches literally.
	// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	new RegExp(`@${escapeRegExp(label)}(?![\\p{L}\\p{N}_-])`, "iu").test(text);

/** Members a text names with `@display name` or `@name`, in group order. */
export function mentionedMembers(
	text: string,
	members: readonly Agent[],
): string[] {
	return members.flatMap((member) =>
		[member.displayName, member.name].some((label) => mentions(text, label))
			? [member.name]
			: [],
	);
}

/**
 * Who answers, in speaking order: members at or above the threshold and every forced member,
 * lowest relevance first so the most relevant speaks last; ties keep group order. Without
 * scores only the forced members answer; with nobody at all, the host answers alone.
 */
export function planRound(input: {
	members: readonly string[];
	host: string;
	scores: Readonly<Record<string, number>> | undefined;
	forced: ReadonlySet<string>;
	threshold?: number;
}): string[] {
	const { members, host, scores, forced } = input;
	const threshold = input.threshold ?? RELEVANCE_THRESHOLD;
	const chosen = members.filter(
		(name) => forced.has(name) || (scores?.[name] ?? 0) >= threshold,
	);
	if (chosen.length === 0) return [host];
	return chosen
		.map((name, index) => ({ name, index, score: scores?.[name] ?? 0 }))
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.map((entry) => entry.name);
}

/** One judge request with one yes-or-no question per member: should it answer this message? */
export class RelevanceScorer {
	readonly #judge: Pick<Judge, "askYesNo">;
	readonly #logger: Logger;
	readonly #owner: OwnerIdentity;

	constructor(
		judge: Pick<Judge, "askYesNo">,
		logger: Logger,
		owner: OwnerIdentity,
	) {
		this.#judge = judge;
		this.#logger = logger;
		this.#owner = owner;
	}

	/** Each member's relevance from 0 to 1; undefined when the judge failed. */
	async score(
		members: readonly Agent[],
		recent: readonly GroupMessage[],
		text: string,
	): Promise<Record<string, number> | undefined> {
		const key = (name: string) => `m_${name.replaceAll("-", "_")}`;
		const questions = Object.fromEntries(
			members.map((member) => [
				key(member.name),
				{
					type: "yesno" as const,
					instructions: `Should the agent "${member.displayName}" answer the owner's newest message in this group chat? Its role:\n${member.prompt.slice(0, PROMPT_CHARS_FOR_SCORING)}`,
					criteria: {
						true: "The message is about this agent's role, asks for knowledge or work it owns, or its view would add something the others would not.",
						false:
							"The message is outside this agent's role, or another member clearly owns it and this agent would add nothing.",
					},
				},
			]),
		);
		const o = ownerWords(this.#owner);
		const state = {
			task: `A group chat between the owner, ${o.name}, and ${o.his} agents. Decide who should answer ${o.his} newest message.`,
			members: members.map((m) => ({ name: m.displayName, id: m.name })),
			recent: recent.slice(-RECENT_FOR_SCORING).map((m) => ({
				from: m.authorName,
				text: m.text.slice(0, SCORING_TEXT_CHARS),
			})),
			newest: text.slice(0, SCORING_TEXT_CHARS),
		};
		try {
			const answers = await this.#judge.askYesNo(state, questions);
			const scores = Object.fromEntries(
				members.map((m) => [m.name, answers[key(m.name)] ?? 0]),
			);
			this.#logger.info({ scores }, "group relevance scored");
			return scores;
		} catch (error) {
			this.#logger.warn({ err: error }, "group relevance scoring failed");
			return undefined;
		}
	}
}
