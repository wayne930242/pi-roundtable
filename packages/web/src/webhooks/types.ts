/** One incoming webhook of an agent room, as the owner's list and the agent's tool show it. */
export interface WebhookView {
	id: string;
	name: string;
	/** `owner`, or the name of the agent that made it. */
	createdBy: string;
	/** ISO times. */
	created: string;
	lastUsed: string | null;
	expiresAt: string | null;
	/** It is revoked after its first accepted post. */
	once: boolean;
}

/** What making a webhook answers: the webhook, and its URL, shown this once. */
export interface CreatedWebhookView {
	webhook: WebhookView;
	url: string;
}

/** The longest a webhook may live before it expires: seven days, in minutes. */
export const MAX_WEBHOOK_MINUTES = 7 * 24 * 60;
/** Live webhooks one agent may have that never expire. */
export const MAX_LASTING_WEBHOOKS = 10;
/** Live webhooks one agent may have that expire. */
export const MAX_EXPIRING_WEBHOOKS = 20;
/** The longest name of a webhook. */
export const MAX_WEBHOOK_NAME = 80;
