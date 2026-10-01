// Unstable plugin helpers; see the plugin guide.

export type {
	TextToolDef,
	ToolInput,
} from "../core/runtime/text-tools.ts";
export {
	requiredString,
	stringList,
	textToolsExtension,
} from "../core/runtime/text-tools.ts";
export { activeToolsExtension } from "../core/shared/active-tools.ts";
export { lastAssistant, textOf } from "../core/shared/session-messages.ts";
export { toolError, toolText } from "../core/shared/tool-result.ts";
