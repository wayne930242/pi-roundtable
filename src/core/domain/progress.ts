/**
 * What a running turn reports as it goes, for a surface that shows it live. Text arrives in
 * chunks joined over a short interval; a tool is named with a short one-line preview of its
 * arguments, never their full text, and ends with whether it succeeded. The final reply still
 * arrives through `sendReply`.
 */
export type TurnProgress =
	| { type: "text"; delta: string }
	| { type: "tool_start"; id: string; tool: string; preview?: string }
	| { type: "tool_end"; id: string; tool: string; ok: boolean };
