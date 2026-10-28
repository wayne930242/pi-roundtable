import type { Logger } from "pi-roundtable";
import { encryptPayload } from "./encrypt.ts";
import type { EndpointPolicy } from "./endpoint.ts";
import { type Vapid, vapidAuthorization } from "./vapid.ts";

/** How long a push service keeps a message for a device that is off: a day. */
const TTL_SECONDS = 86_400;
/** How long one post may take. */
const SEND_TIMEOUT_MS = 10_000;

/** What a notification carries. Everything here is sealed; the push service sees only its size. */
export interface PushPayload {
	title: string;
	body?: string;
	/** The room the notification is about, which a tap opens. */
	room?: string;
	/** Where a tap goes when no page of the app is open: a path under the origin. */
	url?: string;
	/** Notifications with one tag replace each other on the device. */
	tag: string;
	kind: "card" | "cap" | "reply" | "notice";
}

/** The part of a stored subscription the sender needs. */
export interface Target {
	endpoint: string;
	p256dh: string;
	auth: string;
}

/** How a post ended: `sent`, `gone` (the service says the device unsubscribed), or `failed`. */
export type SendResult = "sent" | "gone" | "failed";

export interface PushSenderOptions {
	vapid: Vapid;
	/** The `sub` of the VAPID token: a `mailto:` or `https:` contact for the push service. */
	subject: string;
	policy: EndpointPolicy;
	/** The HTTP client; default `fetch`. */
	fetch?: typeof fetch;
	logger: Logger;
}

/** Posts sealed notifications to the push services (RFC 8030) under the server's VAPID identity (RFC 8292). */
export class PushSender {
	readonly #options: PushSenderOptions;

	constructor(options: PushSenderOptions) {
		this.#options = options;
	}

	async send(target: Target, payload: PushPayload): Promise<SendResult> {
		const { vapid, subject, policy, logger } = this.#options;
		// Checked again at the post: the allowlist may have changed since the device subscribed.
		const checked = policy.check(target.endpoint);
		if ("refusal" in checked) {
			logger.warn(
				{ reason: checked.refusal },
				"a stored push endpoint is not allowed",
			);
			return "gone";
		}
		try {
			const body = await encryptPayload(
				new TextEncoder().encode(JSON.stringify(payload)),
				{
					p256dh: Buffer.from(target.p256dh, "base64url"),
					auth: Buffer.from(target.auth, "base64url"),
				},
			);
			const response = await (this.#options.fetch ?? fetch)(checked.url, {
				method: "POST",
				headers: {
					authorization: await vapidAuthorization(
						vapid,
						target.endpoint,
						subject,
					),
					"content-encoding": "aes128gcm",
					"content-type": "application/octet-stream",
					ttl: String(TTL_SECONDS),
					urgency: payload.kind === "reply" ? "normal" : "high",
				},
				body,
				// A push service never redirects; a redirect would walk past the allowlist.
				redirect: "manual",
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
			});
			await response.body?.cancel();
			if (response.status >= 200 && response.status < 300) return "sent";
			if (response.status === 404 || response.status === 410) return "gone";
			logger.warn(
				{ status: response.status, host: checked.url.host },
				"a push service refused a message",
			);
			return "failed";
		} catch (error) {
			logger.warn(
				{ err: error, host: checked.url.host },
				"a push could not be sent",
			);
			return "failed";
		}
	}
}
