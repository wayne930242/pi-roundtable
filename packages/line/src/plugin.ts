import {
	definePlugin,
	type PluginContext,
	type RoundtablePlugin,
} from "pi-roundtable";
import { LineApi } from "./api.ts";
import { BotIdentity } from "./bot.ts";
import { LineConsumer } from "./consumer.ts";
import { MessageContent } from "./content.ts";
import { type InboxProcessor, InboxWorker } from "./inbox.ts";
import type { LineSubscriber } from "./messages.ts";
import { MIGRATIONS } from "./migrations.ts";
import { checkOptions, type LineOptions } from "./options.ts";
import { LINE, type LineBridgePort } from "./port.ts";
import { RetentionSweeper } from "./retention.ts";
import { PgSources } from "./sources.ts";
import { TokenSource } from "./token.ts";
import { webhookHandler } from "./webhook.ts";

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
			const api = new LineApi({
				tokens,
				...(options.fetch ? { fetch: options.fetch } : {}),
			});
			const bot = new BotIdentity({ api, logger: context.logger, now });
			const sources = new PgSources(sql, () => api, now);
			const consumer = new LineConsumer({
				sql,
				logger: context.logger,
				now,
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
			const worker = new InboxWorker({
				sql,
				logger: context.logger,
				now,
				sources,
				processor: () => subscription?.processor,
				...(options.inbox ? { options: options.inbox } : {}),
			});
			const port: LineBridgePort = {
				sources,
				botUserId: () => bot.current(),
				health: () => {
					const health = tokens.health();
					return {
						tokensIssued: health.issued,
						tokenFailure: health.lastFailure,
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
				http: [
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
						}),
					},
				],
			};
		},
	});
}
