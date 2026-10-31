import type {
	ConnectorAddedView,
	ConnectorInput,
	ManagedConnectorView,
	McpAuthorizeInput,
	McpChannelView,
	McpGrantsView,
	McpUrlView,
} from "../../src/api-types.ts";
import { request } from "./api.ts";

const json = (method: string, body: unknown): RequestInit => ({
	method,
	body: JSON.stringify(body),
});
const part = encodeURIComponent;

/** The Connectors page's management calls, the owners' alone. */
export const connectorsApi = {
	list: () => request<ManagedConnectorView[]>("connectors/managed"),
	/** The token is sent this once; the answer never holds it. */
	add: (input: ConnectorInput) =>
		request<ConnectorAddedView>("connectors/managed", json("POST", input)),
	describe: (name: string, description: string) =>
		request<unknown>(
			`connectors/managed/${part(name)}`,
			json("PATCH", { description }),
		),
	remove: (name: string) =>
		request<unknown>(`connectors/managed/${part(name)}`, { method: "DELETE" }),

	grants: () => request<McpGrantsView>("connectors/grants"),
	channels: () => request<McpChannelView[]>("connectors/grants/channels"),
	authorize: (input: McpAuthorizeInput) =>
		request<McpUrlView>("connectors/grants", json("POST", input)),
	describeGrant: (
		bundle: string,
		channelId: string,
		change: { displayName?: string; description?: string },
	) =>
		request<unknown>(
			`connectors/grants/${part(bundle)}/${part(channelId)}`,
			json("PATCH", change),
		),
	revoke: (bundle: string, channelId: string) =>
		request<unknown>(`connectors/grants/${part(bundle)}/${part(channelId)}`, {
			method: "DELETE",
		}),
	rotate: (bundle: string) =>
		request<McpUrlView>(`connectors/grants/${part(bundle)}/rotate`, {
			method: "POST",
		}),
};
