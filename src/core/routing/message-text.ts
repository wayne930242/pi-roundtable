import type { InboundMessage } from "../domain/conversation.ts";
import type { OwnerIdentity } from "../identity.ts";

/** The message text, then the message it replies to and the message it forwards, when there are. */
export function withReference(
	message: InboundMessage,
	owner: OwnerIdentity,
): string {
	const quoted = message.reference?.text.trim();
	const replied = quoted
		? `${message.text}\n\n## The message this replies to\n${quoted}`
		: message.text;
	const forwarded = message.forwarded;
	if (!forwarded) return replied;
	return `${replied}\n\n## Forwarded by ${owner.name} from ${forwarded.channelMention} (${forwarded.url})\n${forwarded.text.trim() || "(no text; see the attachments)"}`.trim();
}
