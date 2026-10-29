import { createHash } from "node:crypto";
import type { Tier } from "pi-roundtable";
import type {
	PushDevicesView,
	PushDeviceView,
	PushKeyView,
} from "../api-types.ts";
import type { Authenticated } from "../auth/authenticator.ts";
import { ConsoleHttpError as HttpError, json } from "../http.ts";
import { readLimited } from "../request-body.ts";
import type { EndpointPolicy } from "./endpoint.ts";
import type { PushSubscriptions } from "./subscriptions.ts";
import type { Vapid } from "./vapid.ts";

/** The most devices one person may have subscribed. */
export const MAX_DEVICES = 20;
/** The largest JSON body a subscription is sent in. */
const MAX_BODY_BYTES = 8 * 1024;
const MAX_LABEL_CHARS = 80;
/** An uncompressed P-256 point. */
const P256DH_BYTES = 65;
const AUTH_BYTES = 16;

export interface PushApiOptions {
	vapid: Pick<Vapid, "publicKey">;
	policy: EndpointPolicy;
	subscriptions: Pick<PushSubscriptions, "of" | "save" | "remove">;
	/** The tiers whose people may use push. */
	tiers: readonly Tier[];
	/** False when the server has no VAPID contact: devices cannot be added, since nothing would reach them. */
	enabled: boolean;
}

/** What identifies a device in a list without handing its endpoint around: the endpoint's SHA-256, hex. */
const deviceId = (endpoint: string): string =>
	createHash("sha256").update(endpoint).digest("hex");

const decode = (value: unknown, bytes: number, name: string): string => {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
		throw new HttpError(400, `${name} must be base64url.`);
	const raw = Buffer.from(value, "base64url");
	if (raw.byteLength !== bytes || (bytes === P256DH_BYTES && raw[0] !== 4))
		throw new HttpError(400, `${name} is not a valid key.`);
	return value;
};

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
	const raw = await readLimited(request, MAX_BODY_BYTES);
	if (!raw) throw new HttpError(413, "The body is too large.");
	let value: unknown;
	try {
		value = JSON.parse(raw.toString("utf8"));
	} catch {
		throw new HttpError(400, "The body is not JSON.");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new HttpError(400, "The body is not an object.");
	return value as Record<string, unknown>;
}

/**
 * The push routes under `<mount>/api/push/`: the key a browser subscribes against, and the
 * signed-in owner's own devices: list, add, remove. A device is only ever read or removed by the
 * person who added it, and an endpoint is accepted only on a push service the policy allows.
 */
export class PushApi {
	readonly #options: PushApiOptions;

	constructor(options: PushApiOptions) {
		this.#options = options;
	}

	/** Answers `api/push/...`; undefined for any other path. */
	async handle(
		request: Request,
		parts: readonly string[],
		admission: Authenticated,
	): Promise<Response | undefined> {
		const [head, area, name, id] = parts;
		if (head !== "api" || area !== "push") return undefined;
		try {
			const principalId = this.#allowed(admission);
			const { method } = request;
			if (name === "key" && !id && method === "GET")
				return json({
					key: this.#options.vapid.publicKey,
				} satisfies PushKeyView);
			if (name !== "subscriptions")
				throw new HttpError(404, "There is no such API.");
			if (!id && method === "GET")
				return json(await this.#devices(principalId));
			if (!id && method === "POST")
				return await this.#add(request, principalId);
			if (!id && method === "DELETE")
				return await this.#removeEndpoint(request, principalId);
			if (id && method === "DELETE")
				return await this.#removeId(id, principalId);
			throw new HttpError(405, "Method not allowed.");
		} catch (error) {
			if (error instanceof HttpError)
				return json({ error: error.message }, error.status);
			throw error;
		}
	}

	/** The person's own principal, when their tier may use push; the tier is the one this request was admitted at. */
	#allowed(admission: Authenticated): string {
		const { principal, tier } = admission.visitor;
		if (this.#options.tiers.includes(tier)) return principal.id;
		if (this.#options.tiers.length === 1 && this.#options.tiers[0] === "owner")
			throw new HttpError(403, "Only an owner may do this.");
		throw new HttpError(403, "Push is not available to you.");
	}

	async #devices(principalId: string): Promise<PushDevicesView> {
		const devices = await this.#options.subscriptions.of(principalId);
		return {
			devices: devices.map(
				(device): PushDeviceView => ({
					id: deviceId(device.endpoint),
					...(device.label ? { label: device.label } : {}),
					createdAt: device.createdAt.toISOString(),
					...(device.lastOkAt
						? { lastOkAt: device.lastOkAt.toISOString() }
						: {}),
				}),
			),
		};
	}

	async #add(request: Request, principalId: string): Promise<Response> {
		if (!this.#options.enabled)
			throw new HttpError(
				503,
				"Push is not set up: set push.subject on the server.",
			);
		const body = await bodyOf(request);
		const checked = this.#options.policy.check(body.endpoint);
		if ("refusal" in checked) throw new HttpError(400, checked.refusal);
		const keys = body.keys;
		if (typeof keys !== "object" || keys === null)
			throw new HttpError(400, "keys must hold p256dh and auth.");
		const { p256dh, auth } = keys as Record<string, unknown>;
		const label = body.label;
		if (label !== undefined && typeof label !== "string")
			throw new HttpError(400, "label must be text.");
		const endpoint = checked.url.href;
		const saved = await this.#options.subscriptions.save(
			{
				endpoint,
				principalId,
				p256dh: decode(p256dh, P256DH_BYTES, "p256dh"),
				auth: decode(auth, AUTH_BYTES, "auth"),
				...(label?.trim()
					? { label: label.trim().slice(0, MAX_LABEL_CHARS) }
					: {}),
			},
			MAX_DEVICES,
		);
		if (saved === "taken")
			throw new HttpError(
				409,
				"That device is already subscribed by someone else.",
			);
		if (saved === "full")
			throw new HttpError(
				400,
				"Too many devices. Remove one in the settings first.",
			);
		return json({ id: deviceId(endpoint) });
	}

	async #removeEndpoint(
		request: Request,
		principalId: string,
	): Promise<Response> {
		const body = await bodyOf(request);
		const checked = this.#options.policy.check(body.endpoint);
		if ("refusal" in checked) throw new HttpError(400, checked.refusal);
		// Removing a device that is already gone is as good as removing it.
		await this.#options.subscriptions.remove(checked.url.href, principalId);
		return json({ ok: true });
	}

	async #removeId(id: string, principalId: string): Promise<Response> {
		const device = (await this.#options.subscriptions.of(principalId)).find(
			(candidate) => deviceId(candidate.endpoint) === id,
		);
		if (!device) throw new HttpError(404, "There is no such device.");
		await this.#options.subscriptions.remove(device.endpoint, principalId);
		return json({ ok: true });
	}
}
