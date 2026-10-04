// Compaction through Jev (pi-jev-compaction), for host sessions and sandbox sessions alike.

import type {
	ExtensionFactory,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	buildVerbatimSummary,
	type CompactResult,
	collectToolCalls,
	compact,
	estimateSummaryTokens,
	extractKeptMessages,
	type FallbackKind,
	fileOpsFromPreparation,
	type JevAsker,
	JevClient,
	PACKAGE_NAME,
	PACKAGE_VERSION,
	type PackageConfig,
	type PiAgentMessage,
	type PiCompactionResult,
	reductionRatio,
	resolvePackageConfig,
	summarizedJevMessages,
	toJevTranscript,
} from "pi-jev-compaction";
import type { ChannelKey } from "../core/domain/conversation.ts";
import type { Logger } from "../core/log.ts";

/** The engine Jev's compactions record in their details, as pi-jev-compaction's own extension does. */
export const JEV_COMPACTION_ENGINE = PACKAGE_NAME;

/**
 * Past this, the previous summary is condensed by Pi's own summary instead: Jev keeps text
 * verbatim, so every Jev summary carries the one before it whole and the chain only grows.
 */
export const JEV_PREVIOUS_SUMMARY_LIMIT_TOKENS = 60_000;

/** What Jev keeps when it judges which tool calls still matter. */
export const JEV_GOAL =
	"Keep tool results that set rules still in force for the ongoing work: skills, notebook system prompts and AGENTS.md, note formats and style guides, read with invoke-skill, get-system-prompt or read. Drop stale lookups, listings, and finished edits.";

const RULE_TOOL = /(^|-)(invoke-skill|get-system-prompt)$/;
const READ_TOOL = /(^|-)read$/;
const RULE_FILE = /(\/\.agents\/skills\/|(^|\/)(SKILL|AGENTS)\.md$)/;
const ARGS_CHARS = 200;

/** Whether a tool call loads rules: a skill, a notebook system prompt, or a read of SKILL.md, AGENTS.md or `.agents/skills/`. */
export function isRuleLoad(tool: string, args: unknown): boolean {
	if (RULE_TOOL.test(tool)) return true;
	if (!READ_TOOL.test(tool) || typeof args !== "object" || args === null)
		return false;
	const path = (args as { path?: unknown }).path;
	return typeof path === "string" && RULE_FILE.test(path);
}

export interface JevCompactOptions {
	/** What Jev keeps; default `JEV_GOAL`. */
	goal?: string;
	/** A previous summary above this many tokens skips Jev; default `JEV_PREVIOUS_SUMMARY_LIMIT_TOKENS`. */
	previousSummaryLimitTokens?: number;
	/** Which tool calls the summary lists to load again; default `isRuleLoad`. */
	ruleLoad?: (tool: string, args: unknown) => boolean;
	/** pi-jev-compaction's settings (apiKey, model, thresholds), over its config file and environment. */
	config?: PackageConfig;
	/** Answers Jev's questions instead of Jev's service; for tests. */
	asker?: JevAsker;
}

/** Pi's compaction preparation, as Jev reads it. */
export interface JevCompactInput {
	messagesToSummarize: readonly PiAgentMessage[];
	turnPrefixMessages?: readonly PiAgentMessage[];
	/** The messages that stay in the context, which Jev sees but the summary leaves out. */
	keptMessages?: readonly PiAgentMessage[];
	previousSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	customInstructions?: string;
	reason?: string;
	readFiles?: string[];
	modifiedFiles?: string[];
	signal?: AbortSignal;
}

/** Why Jev left a compaction to Pi's summary. */
export type JevSkipReason = FallbackKind | "previous_summary_too_large";

export type JevCompactOutcome =
	| { compaction: PiCompactionResult }
	| { skipped: JevSkipReason; detail?: string };

function classifyError(message: string): FallbackKind {
	if (/aborted/i.test(message)) return "aborted";
	if (/too large for Jev|no room for questions/i.test(message))
		return "cannot_fit";
	return "jev_error";
}

/**
 * Compacts through Jev. The outcome is `skipped`, for Pi's summary to run, when the previous
 * summary is too large or Jev falls back. A Jev summary carries the previous summary once, in the
 * transcript, and ends with the rule loads among the summarized messages so the agent loads them again.
 */
export async function jevCompact(
	input: JevCompactInput,
	options: JevCompactOptions = {},
): Promise<JevCompactOutcome> {
	const previous = input.previousSummary?.trim() ?? "";
	const limit =
		options.previousSummaryLimitTokens ?? JEV_PREVIOUS_SUMMARY_LIMIT_TOKENS;
	if (estimateSummaryTokens(previous) > limit)
		return { skipped: "previous_summary_too_large" };
	const config = resolvePackageConfig({
		...options.config,
		goal: options.goal ?? options.config?.goal ?? JEV_GOAL,
	});
	if (input.signal?.aborted) return { skipped: "aborted" };
	if (!options.asker && !config.apiKey)
		return { skipped: "no_key", detail: "no API key is configured" };
	const transcript = toJevTranscript({
		previousSummary: previous || undefined,
		messagesToSummarize: input.messagesToSummarize,
		turnPrefixMessages: input.turnPrefixMessages,
		keptMessages: input.keptMessages ?? [],
	});
	if (transcript.compactableCount === 0)
		return { skipped: "nothing_to_compact" };
	const candidates = collectToolCalls(
		transcript.messages,
		config.preserveRecentMessages,
	).filter((call) => !call.pinned);
	if (candidates.length === 0) return { skipped: "no_candidates" };
	const asker =
		options.asker ??
		new JevClient({
			apiKey: config.apiKey,
			model: config.model,
			baseUrl: config.baseUrl,
			signal: input.signal,
		});
	let result: CompactResult;
	try {
		result = await compact(transcript.messages, asker, {
			goal: config.goal,
			keepThreshold: config.keepThreshold,
			preserveRecentMessages: config.preserveRecentMessages,
			maxStateTokens: config.maxStateTokens,
			maxRequestTokens: config.maxRequestTokens,
			truncateHeadChars: config.truncateHeadChars,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { skipped: classifyError(message), detail: message };
	}
	if (input.signal?.aborted) return { skipped: "aborted" };
	const reduction = reductionRatio(result);
	if (reduction < config.minReductionRatio)
		return {
			skipped: "reduction_too_small",
			detail: `${Math.round(reduction * 100)}% below ${Math.round(config.minReductionRatio * 100)}%`,
		};
	// The transcript already opens with the previous summary, so the summary's own copy is left out.
	let summary = buildVerbatimSummary(
		summarizedJevMessages(result.messages, transcript),
		result,
		{
			reason: input.reason,
			customInstructions: input.customInstructions,
			readFiles: input.readFiles,
			modifiedFiles: input.modifiedFiles,
		},
	);
	const reloads = ruleLoads(
		[...input.messagesToSummarize, ...(input.turnPrefixMessages ?? [])],
		options.ruleLoad ?? isRuleLoad,
	);
	if (reloads.length > 0)
		summary = `${summary.trimEnd()}\n\n${reloadSection(reloads)}\n`;
	return {
		compaction: {
			summary,
			firstKeptEntryId: input.firstKeptEntryId,
			tokensBefore: input.tokensBefore,
			estimatedTokensAfter: estimateSummaryTokens(summary),
			details: {
				engine: PACKAGE_NAME,
				version: PACKAGE_VERSION,
				stats: result.stats,
				decisions: result.decisions,
				reductionRatio: reduction,
				readFiles: input.readFiles,
				modifiedFiles: input.modifiedFiles,
			},
		},
	};
}

/** The rule loads among the messages, as `tool args` lines, first occurrence first. */
function ruleLoads(
	messages: readonly PiAgentMessage[],
	matches: (tool: string, args: unknown) => boolean,
): string[] {
	const lines = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content))
			continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || typeof block.name !== "string") continue;
			const args = block.arguments ?? block.input ?? {};
			if (!matches(block.name, args)) continue;
			const json = JSON.stringify(args) ?? "";
			lines.add(
				`- \`${block.name}\` ${json.length > ARGS_CHARS ? `${json.slice(0, ARGS_CHARS)}…` : json}`,
			);
		}
	}
	return [...lines];
}

function reloadSection(lines: readonly string[]): string {
	return [
		"## Rules loaded before this compaction",
		"These skill and rule loads may have been dropped from the history above. Load them again before you follow them or write by them:",
		...lines,
	].join("\n");
}

export interface JevExtensionOptions extends JevCompactOptions {
	/** Receives each skip, with its reason and the tokens before. */
	logger: Logger;
}

/**
 * The `compaction` session tool's extension: Jev, or Pi's summary whenever it skips. Place it
 * through the core's tiers: `session.compaction.wrap(jevCompactionExtension({ logger }))`.
 */
export function jevCompactionExtension(
	options: JevExtensionOptions,
): ExtensionFactory {
	return (pi) => {
		pi.on(
			"session_before_compact",
			async ({
				preparation,
				branchEntries,
				customInstructions,
				reason,
				signal,
			}: SessionBeforeCompactEvent) => {
				const files = fileOpsFromPreparation(preparation.fileOps);
				const outcome = await jevCompact(
					{
						messagesToSummarize:
							preparation.messagesToSummarize as PiAgentMessage[],
						turnPrefixMessages:
							preparation.turnPrefixMessages as PiAgentMessage[],
						keptMessages: extractKeptMessages(
							branchEntries as Parameters<typeof extractKeptMessages>[0],
							preparation.firstKeptEntryId,
						),
						previousSummary: preparation.previousSummary,
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						customInstructions,
						reason,
						readFiles: files.readFiles,
						modifiedFiles: files.modifiedFiles,
						signal,
					},
					options,
				);
				if ("compaction" in outcome) return { compaction: outcome.compaction };
				logSkip(options.logger, outcome, preparation.tokensBefore);
				return undefined;
			},
		);
	};
}

/** A sandbox session's compaction preparation, as pi-roundtable-sandbox sends it to the host. */
export interface JevCompactRequest {
	reason: string;
	tokensBefore: number;
	firstKeptEntryId: string;
	messagesToSummarize: readonly object[];
	turnPrefixMessages: readonly object[];
	keptMessages: readonly object[];
	previousSummary?: string;
	customInstructions?: string;
	readFiles: string[];
	modifiedFiles: string[];
}

/** The shape pi-roundtable-sandbox's `compaction` option takes. */
export interface JevCompactor {
	engine: string;
	compact(
		request: JevCompactRequest,
		context: { channel: ChannelKey; signal: AbortSignal },
	): Promise<PiCompactionResult | undefined>;
}

/** A sandbox compactor: `new PiSandboxRuntime({ ..., compaction: jevCompactor({ logger }) })`. */
export function jevCompactor(options: JevExtensionOptions): JevCompactor {
	return {
		engine: JEV_COMPACTION_ENGINE,
		async compact(request, { channel, signal }) {
			const outcome = await jevCompact(
				{
					messagesToSummarize: request.messagesToSummarize as PiAgentMessage[],
					turnPrefixMessages: request.turnPrefixMessages as PiAgentMessage[],
					keptMessages: request.keptMessages as PiAgentMessage[],
					previousSummary: request.previousSummary,
					firstKeptEntryId: request.firstKeptEntryId,
					tokensBefore: request.tokensBefore,
					customInstructions: request.customInstructions,
					reason: request.reason,
					readFiles: request.readFiles,
					modifiedFiles: request.modifiedFiles,
					signal,
				},
				options,
			);
			if ("compaction" in outcome) return outcome.compaction;
			logSkip(options.logger.child({ channel }), outcome, request.tokensBefore);
			return undefined;
		},
	};
}

function logSkip(
	logger: Logger,
	outcome: { skipped: JevSkipReason; detail?: string },
	tokensBefore: number,
): void {
	logger.info(
		{ reason: outcome.skipped, detail: outcome.detail, tokensBefore },
		"Jev leaves the compaction to Pi's summary",
	);
}
