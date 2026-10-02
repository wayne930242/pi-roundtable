import type { ChannelKey, ChatSurface, OutboundReply } from "pi-roundtable";

/** A chat surface for the prefix `test`, which keeps every reply the plugin posts. */
export class RecordingSurface implements ChatSurface {
	readonly surface = "test";
	readonly replies: { channel: ChannelKey; reply: OutboundReply }[] = [];

	async start(): Promise<void> {}

	async sendReply(channel: ChannelKey, reply: OutboundReply): Promise<void> {
		this.replies.push({ channel, reply });
	}

	/** The files posted so far, in order. */
	get files(): { name: string; data: Uint8Array }[] {
		return this.replies.flatMap(({ reply }) => reply.files ?? []);
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
