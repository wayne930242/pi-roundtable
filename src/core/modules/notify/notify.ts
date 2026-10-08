import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Notifier } from "../../domain/ports.ts";
import { type OwnerIdentity, ownerWords } from "../../identity.ts";
import { toolError, toolText } from "../../shared/tool-result.ts";

/** What notify needs in one session. */
export interface SessionNotify {
	/** Sends a person a notice through their own channel; false when none reaches them. */
	notifier: Notifier;
	/**
	 * Whom a call notifies, read when it runs: the conversation's person in a private one, the
	 * turn's speaker in a shared one; or why nobody is, such as in a turn nobody is named for.
	 */
	recipient: () => Promise<{ principalId: string } | { refused: string }>;
	/** How a notice reaches them, completing "Send Ada …", such as "a direct message on Discord". */
	channels: string;
}

/**
 * Registers notify for one session: it sends a notice to the person the conversation serves,
 * through the first direct channel that reaches them, and refuses when none does. Its 0.8 name,
 * `notify_owner`, still names it in a selection and in `toolTiers` until 1.0 (`RENAMED_TOOLS`).
 */
export function notifyExtension(
	notify: SessionNotify,
	owner: OwnerIdentity,
): ExtensionFactory {
	const o = ownerWords(owner);
	return (pi) => {
		pi.registerTool({
			name: "notify",
			label: "Notify",
			description: `Send ${o.name} ${notify.channels}. Use only when ${o.he} asks to be notified or reminded by DM; your normal reply already reaches ${o.him}.`,
			parameters: Type.Object({
				text: Type.String({ description: "The message to send." }),
			}),
			execute: async (_toolCallId, params) => {
				const recipient = await notify.recipient();
				if ("refused" in recipient) return toolError(recipient.refused);
				if (!(await notify.notifier.notify(recipient.principalId, params.text)))
					return toolError(
						"the person this notice is for has no direct channel on this host to send it to",
					);
				return toolText("Sent.");
			},
		});
	};
}
