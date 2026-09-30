import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { OwnerNotifier } from "../../domain/ports.ts";
import { type OwnerIdentity, ownerWords } from "../../identity.ts";
import { toolText } from "../../shared/tool-result.ts";

export function notifyExtension(
	notifier: OwnerNotifier,
	owner: OwnerIdentity,
): ExtensionFactory {
	const o = ownerWords(owner);
	return (pi) => {
		pi.registerTool({
			name: "notify_owner",
			label: "Notify owner",
			description: `Send ${o.name} a direct message on Discord. Use only when ${o.he} asks to be notified or reminded by DM; your normal reply already reaches ${o.him}.`,
			parameters: Type.Object({
				text: Type.String({ description: "The message to send." }),
			}),
			execute: async (_toolCallId, params) => {
				await notifier.notifyOwner(params.text);
				return toolText("Sent.");
			},
		});
	};
}
