// The knights' incoming webhooks, as a knight's sheet's More tab and the Webhooks page manage them.

import type {
	CreatedWebhookView,
	WebhookOverviewView,
	WebhookView,
} from "../../src/webhooks/types.ts";
import { request } from "./api.ts";

const path = (agent: string) => `agents/${encodeURIComponent(agent)}/webhooks`;

export const webhooksApi = {
	/** Every knight's live webhooks, by knight. */
	all: () =>
		request<{ webhooks: WebhookOverviewView[] }>("webhooks").then(
			(r) => r.webhooks,
		),
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
