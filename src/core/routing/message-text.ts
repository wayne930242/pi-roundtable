import { parseChannelKey } from "../contract/surface.ts";
import type { ChannelKey, InboundMessage } from "../domain/conversation.ts";
import type { OwnerIdentity } from "../identity.ts";

/** How the model is told where a forward came from: a Discord channel as its mention, another surface's as its key. */
function sourceLabel(source: ChannelKey): string {
	const { surface, id } = parseChannelKey(source);
	return surface === "discord" ? `<#${id}>` : source;
}

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
	return `${replied}\n\n## Forwarded by ${owner.name} from ${sourceLabel(forwarded.source)} (${forwarded.url})\n${forwarded.text.trim() || "(no text; see the attachments)"}`.trim();
}
