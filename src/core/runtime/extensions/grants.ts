import type { ApprovedBy } from "../../interactions/prompts.ts";

/** What a tool's `run` is told about the approval that released its call. */
export interface Grant {
	/** Who approved it, when a surface or a confirming message said who. */
	by?: ApprovedBy;
	/** The id of the card that approved it; absent when no card did. */
	prompt?: string;
}

/** The approvals of the calls that are running, by tool call id, until each result is back. */
export class Grants {
	readonly #grants = new Map<string, Grant>();

	get(toolCallId: string): Grant | undefined {
		return this.#grants.get(toolCallId);
	}

	set(toolCallId: string, grant: Grant): void {
		this.#grants.set(toolCallId, grant);
	}

	delete(toolCallId: string): void {
		this.#grants.delete(toolCallId);
	}

	clear(): void {
		this.#grants.clear();
	}
}
