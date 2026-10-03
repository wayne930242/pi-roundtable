// Plugin helpers, versioned like the main entry; see the plugin guide.

export { discordKey } from "../core/agents/team-keys.ts";

export {
	channelSegment,
	ownerAttachmentDir,
} from "../core/attachments/attachment-dir.ts";
export { prepareImageBytes } from "../core/attachments/image-prep.ts";
export { ImagePreparationError } from "../core/attachments/image-preparation-error.ts";
export { withAttachmentsBlock } from "../core/attachments/prompt-block.ts";
export { attachmentsOf } from "../core/attachments/turn-attachments.ts";
export type { ChannelQueue } from "../core/routing/channel-queue.ts";
export { channelQueue } from "../core/routing/channel-queue.ts";
export { withReference } from "../core/routing/message-text.ts";
export { outcome, settleTurn } from "../core/routing/settle-turn.ts";
