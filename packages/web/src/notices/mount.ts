import { randomUUID } from "node:crypto";
import type { SQL } from "bun";
import type {
	IdentityService,
	Logger,
	Migration,
	PersonProfiles,
} from "pi-roundtable";
import type { AppSocket, Sockets } from "../app/sockets.ts";
import type { Gate } from "../gate.ts";
import { onboardingArea } from "../onboarding/api.ts";
import { OnboardingService, PUSH_STEP } from "../onboarding/service.ts";
import { builtInSteps } from "../onboarding/steps.ts";
import { OnboardingWaivers } from "../onboarding/waivers.ts";
import type { ResolvedOptions } from "../options.ts";
import { linksArea, peopleArea, profileArea } from "../profile/api.ts";
import { LinkService } from "../profile/links.ts";
import { DeviceRoutes, PushApi } from "../push/api.ts";
import { PushDispatch } from "../push/dispatch.ts";
import { OutboxSender, type PushTransport } from "../push/drain.ts";
import type { EndpointPolicy } from "../push/endpoint.ts";
import {
	type OutboxKind,
	PushOutbox,
	type ReceiptEvent,
} from "../push/outbox.ts";
import { PushPrefsStore } from "../push/prefs.ts";
import type { PushSubscriptions } from "../push/subscriptions.ts";
import type { OutboxRoute } from "../push/triggers.ts";
import type { Vapid } from "../push/vapid.ts";
import { webPushTransport } from "../push/web-push-transport.ts";
import type { WebAppRegistry } from "../web-app.ts";
import { ackFrame, noticesArea } from "./api.ts";
import { NoticeService } from "./service.ts";
import { NoticeStore } from "./store.ts";

/** The tables of notices, push delivery, preferences and waivers. */
export const NOTICE_MIGRATIONS: readonly Migration[] = [
	NoticeStore.migration,
	PushOutbox.migration,
	PushPrefsStore.migration,
	OnboardingWaivers.migration,
];

/** The words of a push the app sends itself when its row carries none (`push.content: "none"`). */
const WORDS: Record<OutboxKind, string> = {
	card: "Card waiting",
	reply: "New reply",
	notice: "Notice",
	test: "Test notification",
	clear: "",
};

export interface NoticesMountOptions {
	database: SQL;
	logger: Logger;
	registry: WebAppRegistry;
	gate: Gate;
	sockets: Pick<Sockets, "anyVisible" | "deliver">;
	identity: IdentityService;
	/** Present on every host that has the identity plugin; the profile page needs it. */
	profiles?: PersonProfiles;
	subscriptions: PushSubscriptions;
	policy: EndpointPolicy;
	mount: string;
	routing: "hash" | "path";
	/** The tiers, content, sender and transports the options resolved to. */
	push: Pick<
		ResolvedOptions["push"],
		| "tiers"
		| "content"
		| "preview"
		| "sender"
		| "transports"
		| "subject"
		| "endpointHosts"
		| "fetch"
	>;
	/** The operator's quiet window for a normal notice; absent = none. */
	quiet?: (at: number) => boolean;
	/** The app's own key, present with the internal sender. */
	vapid?: Vapid;
	onboarding: ResolvedOptions["onboarding"];
}

export interface NoticesMount {
	notices: NoticeService;
	pushApi: PushApi;
	/** Present when the app does not sign: the built-in pushes are queued for the external sender. */
	route?: OutboxRoute;
	outbox: PushOutbox;
	/** Sends a socket its notices and the badge once it is ready. */
	opened(connection: AppSocket): Promise<void>;
	start(): void;
	stop(): Promise<void>;
}

/**
 * Builds the notices, the push outbox and its in-process sender (internal mode), the onboarding
 * service and the profile and link routes, and registers them with the web app. A host plugin
 * reaches the first three through `WEB_APP` once the web service has started.
 */
export function mountNotices(options: NoticesMountOptions): NoticesMount {
	const { database, registry, sockets, identity, logger, push } = options;
	const outbox = new PushOutbox(database);
	const prefs = new PushPrefsStore(database);
	const external = push.sender !== "internal";
	const enabled = external || push.subject !== undefined;
	const transports: PushTransport[] = [];
	if (!external && options.vapid && push.subject)
		transports.push(
			webPushTransport({
				vapid: options.vapid,
				subject: push.subject,
				endpointHosts: push.endpointHosts,
				database,
				...(push.fetch ? { fetch: push.fetch } : {}),
				logger,
			}),
		);
	const sender = external
		? undefined
		: new OutboxSender({
				outbox,
				transports,
				render: (row) => ({
					title: row.title ?? WORDS[row.kind],
					...(row.body ? { body: row.body } : {}),
				}),
				logger,
			});
	const dispatch = new PushDispatch({
		outbox,
		prefs,
		identity,
		tiers: push.tiers,
		content: push.content,
		preview: push.preview,
		visible: (principalId) => sockets.anyVisible(principalId),
		...(options.quiet ? { quiet: options.quiet } : {}),
		...(sender
			? { kick: () => void sender.drain().catch(() => undefined) }
			: {}),
		enabled,
		transports: push.transports,
		logger,
	});
	const routing = { mount: options.mount, routing: options.routing };
	const store = new NoticeStore(database);
	const notices = new NoticeService({
		store,
		dispatch,
		deliver: (frame, principal) => sockets.deliver(frame, { principal }),
		routing,
		logger,
	});
	const pushStatus = {
		status: async (principalId: string) => {
			const lastReceiptAt = await outbox.lastReceiptAt(principalId);
			return {
				devices: (await options.subscriptions.of(principalId)).length,
				...(lastReceiptAt ? { lastReceiptAt } : {}),
				waived: await registry.waived(principalId, PUSH_STEP),
			};
		},
	};
	const waivers = new OnboardingWaivers(database);
	registry.setWaivers(waivers);
	const onboarding = new OnboardingService({
		registry,
		waivers,
		gate: options.gate,
		identity,
		...(options.profiles ? { profiles: options.profiles } : {}),
		push: pushStatus,
		logger,
	});
	const links = new LinkService({
		registry,
		steps: options.onboarding.links,
		identity,
		gate: options.gate,
		logger,
	});
	registry.provide({ notices, onboarding, push: pushStatus });
	for (const step of builtInSteps({
		links: options.onboarding.links,
		push: {
			mode: options.onboarding.push,
			waiver: options.onboarding.pushWaiver,
		},
		pushTiers: push.tiers,
		prover: (provider) => registry.prover(provider),
		identity,
		outbox,
	}))
		registry.registerStep(step);
	registry.onArea(noticesArea(notices));
	registry.onArea(onboardingArea(onboarding));
	registry.onArea(linksArea(links));
	registry.onArea(
		peopleArea({
			profiles: options.profiles ?? { picture: async () => undefined },
			gate: options.gate,
		}),
	);
	if (options.profiles)
		registry.onArea(
			profileArea({
				profiles: options.profiles,
				identity,
				sessionLabel: "Sign-in account",
			}),
		);
	registry.onFrame("ack", ackFrame(notices));

	const receipt = async (
		principalId: string,
		tag: string,
		event: ReceiptEvent,
	): Promise<boolean> => {
		const mine = tag.startsWith("test:")
			? await outbox.has(principalId, "test", tag)
			: await notices.receipt(tag, principalId, event);
		if (!mine) return false;
		await outbox.receipt(principalId, tag, event);
		// A receipt may finish the push step: the gate asks again.
		onboarding.changed(principalId);
		return true;
	};
	const pushApi = new PushApi({
		vapid: {
			publicKey:
				push.sender === "internal"
					? (options.vapid?.publicKey ?? "")
					: push.sender.external.publicKey,
		},
		devices: new DeviceRoutes({
			policy: options.policy,
			subscriptions: options.subscriptions,
			enabled,
		}),
		tiers: push.tiers,
		subscriptions:
			push.sender === "internal" || !push.sender.external.subscribePath,
		...(enabled
			? {
					test: async (principalId: string) => {
						if ((await options.subscriptions.of(principalId)).length === 0)
							return "no-device" as const;
						const tag = `test:${randomUUID()}`;
						await dispatch.test(
							principalId,
							tag,
							`${options.mount}/`,
							await notices.badge(principalId),
						);
						return { tag };
					},
				}
			: {}),
		receipt,
		prefs,
	});
	const route: OutboxRoute | undefined = external
		? { outbox, content: push.content, badge: (id) => notices.badge(id) }
		: undefined;
	let sweeper: ReturnType<typeof setInterval> | undefined;
	return {
		notices,
		pushApi,
		...(route ? { route } : {}),
		outbox,
		opened: async (connection) => {
			for (const frame of await notices.frames(connection.principal.id))
				sockets.deliver(frame, { connection });
		},
		start: () => {
			sender?.start();
			const sweep = () =>
				Promise.all([store.sweep(), outbox.sweep()]).catch((error: unknown) =>
					logger.warn({ err: error }, "old notices were not deleted"),
				);
			void sweep();
			sweeper = setInterval(sweep, 3_600_000);
		},
		stop: async () => {
			clearInterval(sweeper);
			await sender?.stop();
		},
	};
}
