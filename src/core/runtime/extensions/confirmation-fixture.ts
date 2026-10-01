import type { HoldRule } from "../../holds.ts";

/** A tool that waits for the owner's confirmation in the gate's tests. */
export const MAIL = "send-mail";

/** The one neutral hold rule the gate's tests use: sending mail waits for the owner. */
export const MAIL_RULE: HoldRule = {
	name: "mail",
	describe: (tool, input) =>
		tool === MAIL ? `send an email to ${String(input.to)}` : undefined,
};
