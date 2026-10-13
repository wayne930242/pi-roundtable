import {
	definePlugin,
	type PluginContext,
	type RoundtablePlugin,
} from "pi-roundtable";
import { LineApi } from "./api.ts";
import { BotIdentity } from "./bot.ts";
import { LineConsumer, NO_KEEP } from "./consumer.ts";
import { MessageContent } from "./content.ts";
import { iconRoute } from "./icon.ts";
import { type InboxProcessor, InboxWorker } from "./inbox.ts";
import { JoinNotifier } from "./join.ts";
import type { LineSubscriber } from "./messages.ts";
import { MIGRATIONS } from "./migrations.ts";
import { checkOptions, type LineOptions } from "./options.ts";
import { PgOutbox } from "./outbox.ts";
import { OutboxWorker } from "./outbox-worker.ts";
import { LINE, type LineBridgePort } from "./port.ts";
import { QuotaGate } from "./quota.ts";
import { RetentionSweeper } from "./retention.ts";
import { PgSources } from "./sources.ts";
import { LineSurface } from "./surface.ts";
import { TokenSource } from "./token.ts";
import { WebhookStats, webhookHandler } from "./webhook.ts";

/**
 * The LINE transport: a webhook on the host's HTTP listener that stores every signed event before
 * it answers, an inbox worker that hands the stored events of allowed chats to one processor, and
 * the `LINE` service other plugins read the allowlist and health from. A chat the bot has not been
 * told to mirror is recorded as pending with counts only; nothing of what its members write is kept.
 * Configuration mistakes throw here, before the host starts.
 */
export function line(options: LineOptions): RoundtablePlugin {
	const { path } = checkOptions(options);
	// Built now so bad credentials stop the configuration rather than the boot.
	const tokens = new TokenSource({
		credentials: options.credentials,
		...(options.fetch ? { fetch: options.fetch } : {}),
	});
	return definePlugin({
		name: "line",
		migrations: MIGRATIONS,
		provides: [LINE],
		setup: (context: PluginContext) => {
			const sql = context.database();
			const now = () => context.env.now();
			const webhooks = new WebhookStats();
			const api = new LineApi({
				tokens,
				...(options.fetch ? { fetch: options.fetch } : {}),
			});
			const bot = new BotIdentity({ api, logger: context.logger, now });
			const sources = new PgSources(sql, () => api, now);
			const quota = new QuotaGate({
				api,
				now,
				...(options.quota ? { options: options.quota } : {}),
			});
			// Told when a push is queued, so the worker looks as its gathering window ends.
			let outboxWorker: OutboxWorker | undefined;
			const outbox = new PgOutbox({
				sql,
				now,
				sources,
				...(options.outbox ? { options: options.outbox } : {}),
				...(options.sender ? { sender: options.sender } : {}),
				queued: (readyInMs) => outboxWorker?.kickIn(readyInMs),
			});
			const surface = new LineSurface(outbox);
			const joins = new JoinNotifier({
				sql,
				api,
				logger: context.logger,
				now,
				...(options.joinNotice ? { notice: options.joinNotice } : {}),
			});
			if (options.joinNotice && !joins.armed)
				context.logger.warn(
					{ code: "join_notice_digest_mismatch" },
					"the LINE join notice text is not the one its digest names; no notice will be sent",
				);
			const consumer = new LineConsumer({
				sql,
				logger: context.logger,
				now,
				joins,
				...(options.route
					? { route: (message) => surface.deliver(message) }
					: {}),
			});
			const content = new MessageContent(sql, api, options.media);
			// The subscriber and the processor made for it; the worker hands events out only while both are set.
			let subscription:
				| { handler: LineSubscriber; processor: InboxProcessor }
				| undefined;
			// Aborted when the retention service stops, so a hand-back in progress does not outlive the host.
			let sweeping = new AbortController();
			const retention = new RetentionSweeper({
				sql,
				logger: context.logger,
				now,
				strays: async (before) => {
					const attached = subscription;
					return attached
						? consumer.handBackStrays(attached.handler, sweeping.signal, before)
						: 0;
				},
				...(options.retention ? { options: options.retention } : {}),
			});
			// With routing on, the inbox is served without a subscriber too: the router needs the text.
			const routeOnly = options.route
				? consumer.processorFor(async () => undefined)
				: undefined;
			const worker = new InboxWorker({
				sql,
				logger: context.logger,
				now,
				sources,
				processor: () => subscription?.processor ?? routeOnly,
				...(options.inbox ? { options: options.inbox } : {}),
			});
			outboxWorker = new OutboxWorker({
				sql,
				logger: context.logger,
				now,
				api,
				quota,
				sources,
				emit: async (event, signal) => {
					const attached = subscription;
					if (!attached) return false;
					await attached.handler(event, signal, NO_KEEP);
					return true;
				},
				...(options.outbox ? { options: options.outbox } : {}),
			});
			const sending = outboxWorker;
			const port: LineBridgePort = {
				sources,
				outbox,
				botUserId: () => bot.current(),
				health: () => {
					const health = tokens.health();
					return {
						tokensIssued: health.issued,
						tokenFailure: health.lastFailure,
						webhooks: webhooks.health(),
					};
				},
				subscribe: (handler) => {
					if (subscription)
						throw new Error("line: a subscriber is already attached");
					const attached = {
						handler,
						processor: consumer.processorFor(handler),
					};
					subscription = attached;
					worker.kick();
					sending.kick();
					return () => {
						if (subscription === attached) subscription = undefined;
					};
				},
				content: (messageId, request) => content.fetch(messageId, request),
			};
			context.services.provide(LINE, port);
			return {
				services: [
					{
						name: "line-bot",
						startInBackground: () => bot.refresh(),
					},
					{
						name: "line-inbox",
						start: () => worker.start(),
						stop: () => worker.stop(),
						busy: () => worker.busy(),
					},
					{
						name: "line-outbox",
						start: () => sending.start(),
						stop: () => sending.stop(),
						busy: () => sending.busy(),
					},
					{
						name: "line-retention",
						start: () => {
							sweeping = new AbortController();
							retention.start();
						},
						stop: async () => {
							sweeping.abort(
								new Error("line: the retention service is stopping"),
							);
							await retention.stop();
						},
						busy: () => retention.busy(),
					},
				],
				surfaces: [surface],
				http: [
					...(options.senderIconRoute
						? [iconRoute(options.senderIconRoute, options.listener ?? "public")]
						: []),
					{
						name: "line-webhook",
						listener: options.listener ?? "public",
						path: { exact: path },
						methods: ["POST"],
						handle: webhookHandler({
							sql,
							tokens,
							logger: context.logger,
							now,
							botUserId: () => bot.current(),
							stored: () => worker.kick(),
							stats: webhooks,
						}),
					},
				],
			};
		},
	});
}
