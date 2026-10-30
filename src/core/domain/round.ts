/**
 * Where a group's round stands, for a surface that shows it: who speaks now, who is next and who
 * has spoken. A round is the members' answers to one owner message, one after another; this is what
 * the core tells a surface at each step, and a surface that shows no rounds never hears it.
 */
export type RoundEnd =
	/** Every member in the order has spoken. */
	| "done"
	/** The round reached the most replies a round holds, with members still waiting. */
	| "limit"
	/** The owner pressed Stop: the running turn ended and the members waiting did not speak. */
	| "stopped";

export interface RoundProgress {
	/** The group message id of the line that opened the round; one round has one id. */
	id: number;
	state: "running" | "ended";
	/** The member speaking now, by name. */
	current?: string;
	/** The members still to speak, in order, a handoff appended. */
	next: string[];
	/** The members who have replied so far, in order. */
	spoken: string[];
	/** The replies made so far, and the most a round holds. */
	replies: number;
	limit: number;
	/** Why a round that has ended ended. */
	ended?: RoundEnd;
	/** The owner's messages waiting in the channel for the next round. */
	queued?: number;
}
