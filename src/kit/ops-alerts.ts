// Plugin helpers, versioned like the main entry; see the plugin guide.
// Short alerts for the people who run a host, held to a window so a fault cannot flood them.

export type {
	OpsAlertKind,
	OpsAlertsOptions,
	OpsRaiseOptions,
} from "../core/ops/ops-alerts.ts";
export { OpsAlerts } from "../core/ops/ops-alerts.ts";
