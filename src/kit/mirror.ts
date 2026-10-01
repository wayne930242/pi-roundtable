// Plugin helpers, versioned like the main entry; see the plugin guide.
// Mirror a built-in tool in a worker that cannot reach the host: the specs and the dispatcher.

export type { ScheduleToolContext } from "../core/modules/schedules/schedule-tools.ts";
export { callScheduleTool } from "../core/modules/schedules/schedule-tools.ts";
export {
	DELEGATE_TOOL,
	DELEGATE_TOOL_SPEC,
} from "../core/shared/delegate-tool.ts";
export type {
	ScheduleToolName,
	ScheduleToolSpec,
	ScheduleToolWording,
} from "../core/shared/schedule-tools.ts";
export {
	isScheduleTool,
	SCHEDULE_TOOLS,
	scheduleToolSpecs,
} from "../core/shared/schedule-tools.ts";
