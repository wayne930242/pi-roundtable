import type { HostContext } from "./host-context.ts";

const DAY_MS = 86_400_000;

/** What one sweep of the host kinds' retention removed. */
export interface HostSweep {
	messages: number;
	cards: number;
	files: number;
}

/**
 * Deletes what the registered kinds no longer keep: for a kind with `retention`, its messages and
 * cards older than `textDays` (counted from the message's own time, so an import dated long ago
 * goes at once), and the files those messages carried. Files have their own expiry, which the
 * stored files' sweep applies; a message whose files went first keeps its row and says "file expired".
 */
export async function sweepHostKinds(
	ctx: Pick<
		HostContext,
		"registry" | "surface" | "log" | "cards" | "reads" | "files" | "now"
	>,
): Promise<HostSweep> {
	const total: HostSweep = { messages: 0, cards: 0, files: 0 };
	for (const kind of ctx.registry.kinds()) {
		if (!kind.retention) continue;
		const prefix = `${ctx.surface}:${kind.kind}.`;
		const before = new Date(ctx.now() - kind.retention.textDays * DAY_MS);
		const gone = await ctx.log.sweepKind(prefix, before);
		total.messages += gone.length;
		for (const message of gone)
			for (const file of message.files)
				if (ctx.files.binding(file.id)?.room === message.room) {
					ctx.files.remove(file.id);
					total.files += 1;
				}
		total.cards += await ctx.cards.sweepKind(prefix, before);
		await ctx.reads.sweepOrphans(prefix);
	}
	return total;
}
