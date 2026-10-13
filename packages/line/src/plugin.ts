import {
	definePlugin,
	type PluginContext,
	type RoundtablePlugin,
} from "pi-roundtable";
import { LineApi } from "./api.ts";
import { BotIdentity } from "./bot.ts";
import { type InboxProcessor, InboxWorker } from "./inbox.ts";
import { INBOX_MIGRATION } from "./migrations.ts";
import { checkOptions, type LineOptions } from "./options.ts";
import { LINE, type LineBridgePort } from "./port.ts";
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
		migrations: [INBOX_MIGRATION],
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
			let processor: InboxProcessor | undefined;
			const worker = new InboxWorker({
				sql,
				logger: context.logger,
				now,
				sources,
				processor: () => processor,
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
				attachProcessor: (attached) => {
					if (processor)
						throw new Error("line: an inbox processor is already attached");
					processor = attached;
					worker.kick();
					return () => {
						if (processor === attached) processor = undefined;
					};
				},
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
