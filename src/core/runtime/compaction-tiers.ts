import {
	type ExtensionAPI,
	type ExtensionFactory,
	estimateTokens,
	type SessionBeforeCompactEvent,
	type SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** Past this, a large-window session compacts through the compaction extension. */
export const SOFT_COMPACT_TOKENS = 300_000;
/** Past this, a compaction is pi's own summary, never the extension's. */
export const HARD_COMPACT_TOKENS = 500_000;
/**
 * How far below a threshold a compaction must leave the context for that threshold to fire
 * again, so a compaction that barely helped does not repeat on the next request.
 */
export const COMPACT_HEADROOM_TOKENS = 50_000;

/** Who wrote a compaction: the plugin's compaction extension or Pi's own summary. */
export type CompactionEngine = "extension" | "pi";

/** The session reads the tiers need; a SessionManager or an extension's read-only one. */
export type CompactionHistory = Pick<
	SessionManager,
	"getBranch" | "buildSessionProjection"
>;

export interface LatestCompaction {
	id: string;
	engine: CompactionEngine;
	/** Estimated context the compaction left: its summary and the entries it kept. */
	contextTokens: number;
}

/** The extension's compactions record its `engine` in their details; Pi's own do not. */
export function compactionEngine(
	details: unknown,
	extensionEngine: string | undefined,
): CompactionEngine {
	const engine = (details as { engine?: unknown } | undefined)?.engine;
	return extensionEngine !== undefined && engine === extensionEngine
		? "extension"
		: "pi";
}

/** The branch's latest compaction, measured from the session as it stands now. */
export function latestCompaction(
	history: CompactionHistory,
	extensionEngine: string | undefined,
): LatestCompaction | undefined {
	const branch = history.getBranch();
	const index = branch.findLastIndex((entry) => entry.type === "compaction");
	const entry = branch[index];
	if (entry?.type !== "compaction") return undefined;
	const upToCompaction = new Set(
		branch.slice(0, index + 1).map((each) => each.id),
	);
	let contextTokens = 0;
	for (const projected of history.buildSessionProjection().entries) {
		if (!upToCompaction.has(projected.sourceEntry.id)) continue;
		for (const message of projected.messages)
			contextTokens += estimateTokens(message);
	}
	return {
		id: entry.id,
		engine: compactionEngine(entry.details, extensionEngine),
		contextTokens,
	};
}

/**
 * The context size a session compacts past, or undefined for pi's own threshold. Large windows
 * compact at the soft threshold; a compaction that left the context near or above it moves the
 * next one to the hard ceiling, and one of pi's that left it near the ceiling to pi's threshold.
 */
export function compactionTrigger(
	contextWindow: number,
	reserveTokens: number,
	latest: LatestCompaction | undefined,
): number | undefined {
	const native = contextWindow - reserveTokens;
	if (native <= SOFT_COMPACT_TOKENS) return undefined;
	const left = latest?.contextTokens ?? 0;
	if (left <= SOFT_COMPACT_TOKENS - COMPACT_HEADROOM_TOKENS)
		return SOFT_COMPACT_TOKENS;
	if (native <= HARD_COMPACT_TOKENS) return undefined;
	// Only pi's summary fires at the ceiling, so the extension's compaction near it still leaves pi a turn.
	const piStalled =
		latest?.engine === "pi" &&
		left > HARD_COMPACT_TOKENS - COMPACT_HEADROOM_TOKENS;
	return piStalled ? undefined : HARD_COMPACT_TOKENS;
}

/** Why a compaction of this size must be pi's summary rather than the extension's, if it must. */
export function extensionBypass(
	tokensBefore: number,
	latest: LatestCompaction | undefined,
): string | undefined {
	if (tokensBefore > HARD_COMPACT_TOKENS) return "above the hard ceiling";
	if (
		latest?.engine === "extension" &&
		latest.contextTokens > HARD_COMPACT_TOKENS
	)
		return "The extension's last compaction left the context above the hard ceiling";
	return undefined;
}

/** One session's compaction tiers, measured from its own history. */
export class CompactionTiers {
	readonly #history: CompactionHistory;
	readonly #contextWindow: (provider: string, id: string) => number | undefined;
	readonly #extensionEngine: string | undefined;
	#cached: { id: string; latest: LatestCompaction } | undefined;

	constructor(
		history: CompactionHistory,
		contextWindow: (provider: string, id: string) => number | undefined,
		/** The `engine` the compaction extension records in its compactions' details. */
		extensionEngine?: string,
	) {
		this.#history = history;
		this.#contextWindow = contextWindow;
		this.#extensionEngine = extensionEngine;
	}

	/** The latest compaction; measured once per compaction, since pi checks before every request. */
	latest(): LatestCompaction | undefined {
		const branch = this.#history.getBranch();
		const entry = branch.findLast((each) => each.type === "compaction");
		if (!entry) return undefined;
		if (this.#cached?.id !== entry.id) {
			const latest = latestCompaction(this.#history, this.#extensionEngine);
			if (!latest) return undefined;
			this.#cached = { id: entry.id, latest };
		}
		return this.#cached.latest;
	}

	/** The context size the model compacts past, or undefined for pi's own threshold. */
	trigger(
		model: { provider: string; id: string },
		reserveTokens: number,
	): number | undefined {
		const window = this.#contextWindow(model.provider, model.id);
		if (!window) return undefined;
		return compactionTrigger(window, reserveTokens, this.latest());
	}

	/** pi's in-memory settings, with each model's reserve set so it compacts at its tier. */
	settings(): SettingsManager {
		const settings = SettingsManager.inMemory({});
		const base = settings.getCompactionSettings.bind(settings);
		settings.getCompactionSettings = (model) => {
			const resolved = base(model);
			const window = model && this.#contextWindow(model.provider, model.id);
			const trigger = model && this.trigger(model, resolved.reserveTokens);
			if (!window || trigger === undefined) return resolved;
			return { ...resolved, reserveTokens: window - trigger };
		};
		return settings;
	}

	/**
	 * Wraps a compaction extension so a compaction past the hard ceiling skips it and pi's summary
	 * runs. pi keeps the last handler result and stops only on cancel, so a handler of the assistant's
	 * own could not keep the extension from answering; wrapping its registration can.
	 */
	wrapCompactor(
		compactor: ExtensionFactory,
		onBypass: (details: { reason: string; tokensBefore: number }) => void,
	): ExtensionFactory {
		const gate = (event: SessionBeforeCompactEvent): boolean => {
			const { tokensBefore } = event.preparation;
			const reason = extensionBypass(tokensBefore, this.latest());
			if (reason) onBypass({ reason, tokensBefore });
			return reason === undefined;
		};
		type Handler = (event: unknown, ctx: unknown) => unknown;
		return (pi) => {
			const register = pi.on.bind(pi) as (
				event: string,
				handler: Handler,
			) => () => void;
			const on = ((event: string, handler: Handler) => {
				if (event !== "session_before_compact") return register(event, handler);
				return register(event, (compaction, ctx) =>
					gate(compaction as SessionBeforeCompactEvent)
						? handler(compaction, ctx)
						: undefined,
				);
			}) as ExtensionAPI["on"];
			return compactor(
				new Proxy(pi, {
					get: (target, prop, receiver) =>
						// pi-lens-ignore: no-reflect-get — a Proxy get trap: the receiver keeps a getter's `this` on the proxy, which target[prop] would not
						prop === "on" ? on : Reflect.get(target, prop, receiver),
				}),
			);
		};
	}
}
