// The panes of the console, re-exported by `api-types.ts`.

/** The panes the console can show; the options choose which ones a host serves. */
export const PANES = [
	"overview",
	"conversations",
	"notes",
	"skills",
	"presets",
	"webhooks",
	"connectors",
	"rooms",
	"schedules",
	"table",
	"workspace",
	"profile",
] as const;
export type PaneName = (typeof PANES)[number];

/** The panes only an owner is served: they show the whole host. A member's table seats only their host rooms. */
export const OWNER_ONLY_PANES = [
	"overview",
	"skills",
	"presets",
	"webhooks",
	"connectors",
	"workspace",
] as const satisfies readonly PaneName[];
