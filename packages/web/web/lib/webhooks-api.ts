// A knight's incoming webhooks, as its sheet's More tab manages them.

import type {
	CreatedWebhookView,
	WebhookView,
} from "../../src/webhooks/types.ts";
import { request } from "./api.ts";

const path = (agent: string) => `agents/${encodeURIComponent(agent)}/webhooks`;

export const webhooksApi = {
	list: (agent: string) =>
		request<{ webhooks: WebhookView[] }>(path(agent)).then((r) => r.webhooks),
	create: (
		agent: string,
		made: { name: string; expiresInMinutes?: number; once?: boolean },
	) =>
		request<CreatedWebhookView>(path(agent), {
			method: "POST",
			body: JSON.stringify(made),
		}),
	revoke: (agent: string, id: string) =>
		request<unknown>(`${path(agent)}/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),
};
