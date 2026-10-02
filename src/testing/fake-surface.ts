import type { ChannelKey, ChatSurface, OutboundReply } from "pi-roundtable";

/**
 * A chat surface for the prefix `test` that accepts files and keeps every reply sent through it.
 * The plugin attaches its images to the agent's reply, so a test that finds anything here has
 * found a tool posting on its own.
 */
export class RecordingSurface implements ChatSurface {
	readonly surface = "test";
	readonly supportsFiles = true;
	readonly replies: { channel: ChannelKey; reply: OutboundReply }[] = [];

	async start(): Promise<void> {}

	async sendReply(channel: ChannelKey, reply: OutboundReply): Promise<void> {
		this.replies.push({ channel, reply });
	}
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The size of a PNG, read from its header, or undefined when the bytes are not a PNG. */
export function pngSize(
	data: Uint8Array,
): { width: number; height: number } | undefined {
	if (!PNG_SIGNATURE.every((byte, i) => data[i] === byte)) return undefined;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}
