import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Notifier } from "../../domain/ports.ts";
import { addresseeWords, type OwnerIdentity } from "../../identity.ts";
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
	/** Whom the description names: the private conversation's person, or the speaker. */
	addressee: OwnerIdentity,
	/**
	 * Whom it names at each turn, when that may change while the session is open, such as when the
	 * host gains or loses an owner; the tool is described anew before a turn whose words differ.
	 */
	current?: () => Promise<OwnerIdentity>,
): ExtensionFactory {
	const tool = (who: OwnerIdentity) => {
		const o = addresseeWords(who);
		return {
			name: "notify",
			label: "Notify",
			description: `Send ${o.name} ${notify.channels}. Use only when ${o.he} asks to be notified or reminded by DM; your normal reply already reaches ${o.him}.`,
			parameters: Type.Object({
				text: Type.String({ description: "The message to send." }),
			}),
			execute: async (_toolCallId: string, params: { text: string }) => {
				const recipient = await notify.recipient();
				if ("refused" in recipient) return toolError(recipient.refused);
				if (!(await notify.notifier.notify(recipient.principalId, params.text)))
					return toolError(
						"the person this notice is for has no direct channel on this host to send it to",
					);
				return toolText("Sent.");
			},
		};
	};
	return (pi) => {
		let described = tool(addressee);
		pi.registerTool(described);
		if (!current) return;
		pi.on("before_agent_start", async () => {
			const now = tool(await current());
			if (now.description === described.description) return;
			described = now;
			pi.registerTool(now);
		});
	};
}
