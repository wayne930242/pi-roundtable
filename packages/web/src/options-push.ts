import { TIERS } from "pi-roundtable";
import {
	DEFAULT_UPLOAD_MAX_BYTES,
	UPLOAD_FRAMING_BYTES,
} from "./app/uploads.ts";
import { fail } from "./options-common.ts";
import type { ResolvedOptions, WebConsoleOptions } from "./options-types.ts";
import { isHostPattern } from "./push/endpoint.ts";
import {
	DEFAULT_QUIET_HOURS,
	minutesOfDay,
	type QuietWindow,
} from "./push/quiet-hours.ts";
import { pushFetchOf } from "./push/test-fetch.ts";

export function checkQuietHours(
	value: QuietWindow | false | undefined,
): QuietWindow | undefined {
	if (value === undefined) return { ...DEFAULT_QUIET_HOURS };
	if (value === false) return undefined;
	const bad = () =>
		fail(
			'push.quietHours must be false or {start, end} as two different HH:MM times, such as {start: "23:00", end: "08:00"}',
		);
	if (typeof value !== "object" || value === null) return bad();
	const { start, end } = value as Partial<QuietWindow>;
	if (typeof start !== "string" || typeof end !== "string") return bad();
	const from = minutesOfDay(start);
	const to = minutesOfDay(end);
	if (from === undefined || to === undefined || from === to) return bad();
	return { start, end };
}

export function checkPush(
	options: WebConsoleOptions,
	origin: string,
): ResolvedOptions["push"] {
	const push = options.push;
	if (push?.preview !== undefined && typeof push.preview !== "boolean")
		fail("push.preview must be true or false");
	const quietHours = checkQuietHours(push?.quietHours);
	const hosts = push?.endpointHosts ?? [];
	if (!Array.isArray(hosts))
		fail("push.endpointHosts must be a list of host names");
	for (const host of hosts)
		if (typeof host !== "string" || !isHostPattern(host))
			fail(
				`push.endpointHosts has ${JSON.stringify(host)}, which is not a host name such as push.example.com or *.push.example.com`,
			);
	const given = push?.subject;
	if (
		given !== undefined &&
		!(
			typeof given === "string" &&
			(/^mailto:[^\s@]+@[^\s@]+$/.test(given) ||
				(URL.parse(given)?.protocol === "https:" && !/\s/.test(given)))
		)
	)
		fail(
			"push.subject must be a mailto: address or an https: URL, such as mailto:ops@example.com",
		);
	const tiers = push?.tiers ?? ["owner"];
	if (
		!Array.isArray(tiers) ||
		tiers.length === 0 ||
		!tiers.every((tier) => TIERS.includes(tier))
	)
		fail(`push.tiers must be a list of ${TIERS.join(", ")}`);
	const sender = push?.sender ?? "internal";
	if (sender !== "internal") {
		const external = (sender as { external?: unknown } | null)?.external as
			| { publicKey?: unknown; subscribePath?: unknown }
			| undefined;
		if (
			typeof external !== "object" ||
			external === null ||
			typeof external.publicKey !== "string" ||
			!/^[A-Za-z0-9_-]{80,100}$/.test(external.publicKey) ||
			(external.subscribePath !== undefined &&
				(typeof external.subscribePath !== "string" ||
					!external.subscribePath.startsWith("/")))
		)
			fail(
				'push.sender must be "internal" or { external: { publicKey, subscribePath? } } with the VAPID public key (base64url) and, when the sender serves the subscription routes, their path',
			);
	}
	const content = push?.content ?? (sender === "internal" ? "full" : "none");
	if (content !== "full" && content !== "none")
		fail('push.content must be "full" or "none"');
	const extra = push?.transports ?? [];
	if (
		!Array.isArray(extra) ||
		!extra.every(
			(name) => typeof name === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(name),
		)
	)
		fail("push.transports must be a list of transport names such as slack");
	return {
		preview: push?.preview ?? true,
		quietHours,
		endpointHosts: [...hosts],
		subject: given ?? (origin.startsWith("https:") ? origin : undefined),
		fetch: pushFetchOf(options),
		tiers: [...new Set(tiers)],
		sender:
			sender === "internal"
				? "internal"
				: {
						external: {
							publicKey: (sender as { external: { publicKey: string } })
								.external.publicKey,
							...((sender as { external: { subscribePath?: string } }).external
								.subscribePath
								? {
										subscribePath: (
											sender as { external: { subscribePath: string } }
										).external.subscribePath,
									}
								: {}),
						},
					},
		content,
		transports: [
			"web-push",
			...new Set(extra.filter((name) => name !== "web-push")),
		],
	};
}

export function checkOnboarding(
	options: WebConsoleOptions,
): ResolvedOptions["onboarding"] {
	const given = options.onboarding;
	if (given === undefined) return { links: {}, push: "off", pushWaiver: false };
	if (typeof given !== "object" || given === null)
		fail("onboarding must be an object such as { links: { line: 'nudge' } }");
	const links = given.links ?? {};
	if (typeof links !== "object" || links === null || Array.isArray(links))
		fail("onboarding.links must map a provider to required or nudge");
	for (const [provider, step] of Object.entries(links)) {
		if (!provider.trim())
			fail("onboarding.links names a provider with an empty name");
		if (step !== "required" && step !== "nudge")
			fail(
				`onboarding.links.${provider} must be required or nudge, not ${JSON.stringify(step)}`,
			);
	}
	const push = given.push ?? "off";
	if (push !== "required" && push !== "nudge" && push !== "off")
		fail("onboarding.push must be required, nudge or off");
	if (given.pushWaiver !== undefined && typeof given.pushWaiver !== "boolean")
		fail("onboarding.pushWaiver must be true or false");
	return { links: { ...links }, push, pushWaiver: given.pushWaiver === true };
}

export function checkUploads(options: WebConsoleOptions): number {
	const days = options.uploads?.keepDays;
	if (days === undefined) return 30;
	if (!Number.isInteger(days) || days < 1 || days > 3650)
		fail("uploads.keepDays must be a whole number of days from 1 to 3650");
	return days;
}

/** The largest `uploadMaxBytes`: the limit is also the listener's body limit. */
const MAX_UPLOAD_MAX_BYTES = 4 * 1024 ** 3;

export function checkUploadMax(bytes: number | undefined): number {
	if (bytes === undefined) return DEFAULT_UPLOAD_MAX_BYTES;
	if (
		typeof bytes !== "number" ||
		!Number.isSafeInteger(bytes + UPLOAD_FRAMING_BYTES) ||
		bytes < 1 ||
		bytes > MAX_UPLOAD_MAX_BYTES
	)
		fail(
			"uploadMaxBytes must be a whole number of bytes, from 1 to 4 GiB, that the upload route can ask the listener to take with the form's framing added",
		);
	return bytes;
}
