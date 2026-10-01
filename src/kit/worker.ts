// Unstable plugin helpers; see the plugin guide.
// Running a Pi session of your own: MCP servers for it, its work timeout, its held-action cards.

export {
	approvalCard,
	canonicalJson,
} from "../core/runtime/extensions/confirmation-gate.ts";
export type { VirtualServer } from "../core/runtime/mcp.ts";
export { mcpExtension } from "../core/runtime/mcp.ts";
export type { PromptSlot } from "../core/runtime/prompt-slot.ts";
export { promptSlot, workTimeout } from "../core/runtime/prompt-slot.ts";
export { archiveSessions } from "../core/runtime/session-archive.ts";
export { runWorkerTask } from "../core/runtime/worker-task.ts";
export type { McpEndpoint } from "../core/shared/mcp-adapter.ts";
export { mcpAdapterExtension } from "../core/shared/mcp-adapter.ts";
export { readAttachmentExtension } from "../core/shared/read-attachment-tool.ts";
