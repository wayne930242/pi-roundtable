// Plugin helpers, versioned like the main entry; see the plugin guide.

export type { BlockSupport } from "../core/domain/block-support.ts";
export { zonedStampIn as zonedStamp } from "../core/kernel/time.ts";
export { headline } from "../core/presentation/headline.ts";
export { quietLinks } from "../core/presentation/quiet-links.ts";
export { chunksFor } from "../core/presentation/reply-chunks.ts";
export { splitReply } from "../core/presentation/reply-splitter.ts";
export { thinkingLine } from "../core/presentation/thinking-line.ts";
