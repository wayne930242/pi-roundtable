/**
 * What a running turn reports as it goes, for a surface that shows it live. Text arrives in
 * chunks joined over a short interval; a tool is named with a short one-line preview of its
 * arguments, never their full text, and ends with whether it succeeded. The final reply still
 * arrives through `sendReply`.
 */

/**
 * Why a hold refused a tool call, as a tool's end reports it, so a surface need not tell a call
 * the owner turned down from a call that failed: `declined` on its approval card, `expired` when
 * the card went unanswered (the call is held for the owner's next message), `pending` while the
 * card stays open, and `held` when no card could be shown (the call waits for the owner's next
 * message). A turn that was stopped is none of these.
 */
export type HoldRefusal = "declined" | "expired" | "pending" | "held";

export type TurnProgress =
	| { type: "text"; delta: string }
	| { type: "tool_start"; id: string; tool: string; preview?: string }
	| {
			type: "tool_end";
			id: string;
			tool: string;
			ok: boolean;
			/** Set only on a failed end that a hold refused; absent for a success and for a real failure. */
			refused?: HoldRefusal;
	  };
