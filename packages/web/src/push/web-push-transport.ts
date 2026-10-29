import type { SQL } from "bun";
import type { Logger } from "pi-roundtable";
import type { PushTransport } from "./drain.ts";
import { EndpointPolicy } from "./endpoint.ts";
import { type PushPayload, PushSender } from "./sender.ts";
import { PushSubscriptions } from "./subscriptions.ts";
import { readVapid, type Vapid } from "./vapid.ts";

/** The name of the Web Push transport, which a notice's `via` may name. */
export const WEB_PUSH = "web-push";

export interface WebPushTransportOptions {
	/** The key the devices subscribed against. Read when the first push is sent; it must exist. */
	vapidFile?: string;
	/** The key itself, when the caller already holds it (the app's own sender). */
	vapid?: Vapid;
	/** The VAPID `sub`: a `mailto:` or `https:` contact for the push services. */
	subject: string;
	/** Push services besides the browsers' own, as `push.endpointHosts` writes them. */
	endpointHosts?: readonly string[];
	database: SQL;
	/** The HTTP client; default `fetch`. */
	fetch?: typeof fetch;
	logger?: Logger;
}

/** A logger that says nothing, for a sender run without one. */
const silent: Logger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
	fatal: () => undefined,
	child: () => silent,
};

/** What a push says on a device, from the row and the words the sender gave it. */
export function payloadOf(
	row: Parameters<PushTransport["send"]>[0],
	rendered: Parameters<PushTransport["send"]>[1],
): PushPayload {
	return {
		kind: row.kind,
		title: rendered.title,
		...(rendered.body ? { body: rendered.body } : {}),
		tag: row.tag,
		url: row.open,
		badge: row.badge,
		urgency: row.urgency,
	};
}

/**
 * Web Push to all the devices a person subscribed. It reads their subscriptions, posts a sealed
 * payload to each under the VAPID key, forgets a device the push service says is gone, and counts
 * a failure against one that keeps failing. `sent` when at least one device took it; `gone` when
 * every device was gone; `skipped` when the person has no device.
 */
export function webPushTransport(
	options: WebPushTransportOptions,
): PushTransport {
	const subscriptions = new PushSubscriptions(options.database);
	const policy = new EndpointPolicy(options.endpointHosts);
	const logger = options.logger ?? silent;
	let sender: Promise<PushSender> | undefined;
	const senderOf = (): Promise<PushSender> => {
		sender ??= (async () => {
			const vapid =
				options.vapid ??
				(options.vapidFile ? await readVapid(options.vapidFile) : undefined);
			if (!vapid) throw new Error("webPushTransport needs vapidFile or vapid");
			return new PushSender({
				vapid,
				subject: options.subject,
				policy,
				...(options.fetch ? { fetch: options.fetch } : {}),
				logger,
			});
		})();
		return sender;
	};
	return {
		name: WEB_PUSH,
		async send(row, rendered, signal) {
			const devices = await subscriptions.of(row.principalId);
			if (devices.length === 0) return "skipped";
			const push = await senderOf();
			const payload = payloadOf(row, rendered);
			let sent = 0;
			let gone = 0;
			for (const device of devices) {
				if (signal.aborted) break;
				const result = await push.send(device, payload);
				if (result === "sent") {
					sent += 1;
					await subscriptions.delivered(device.endpoint);
				} else if (result === "gone") {
					gone += 1;
					await subscriptions.forget(device.endpoint);
				} else await subscriptions.failed(device.endpoint);
			}
			if (sent > 0) return "sent";
			return gone === devices.length ? "gone" : "failed";
		},
	};
}
