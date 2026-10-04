import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { JevAsker, PiAgentMessage } from "pi-jev-compaction";
import type { ChannelKey } from "../core/domain/conversation.ts";
import { recordingLogger } from "../core/testing/recording-logger.ts";
import {
	JEV_COMPACTION_ENGINE,
	JEV_PREVIOUS_SUMMARY_LIMIT_TOKENS,
	type JevCompactInput,
	type JevCompactOptions,
	jevCompact,
	jevCompactionExtension,
	jevCompactor,
} from "./jev.ts";

/** A Jev that drops every call it is asked about. */
const dropAll: JevAsker = {
	ask: async (_state, questions) => ({
		answers: Object.fromEntries(
			Object.keys(questions).map((key) => [key, { type: "noul", noul: 0 }]),
		),
	}),
};

const failing: JevAsker = {
	ask: async () => {
		throw new Error("Jev is down");
	},
};

const call = (id: string, name: string, args: unknown): PiAgentMessage[] => [
	{
		role: "assistant",
		content: [
			{ type: "text", text: `calling ${name}` },
			{ type: "toolCall", id, name, arguments: args },
		],
	},
	{
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: `result of ${id} `.repeat(400) }],
	},
];

const messages: PiAgentMessage[] = [
	{ role: "user", content: [{ type: "text", text: "write the prep note" }] },
	...call("c1", "mygitnotes-invoke-skill", { name: "session-prep" }),
	...call("c2", "mygitnotes-get-system-prompt", { notebookId: "sos-02" }),
	...call("c3", "mygitnotes-read", {
		path: "notes/sos-02/.agents/skills/prep/SKILL.md",
	}),
	...call("c4", "read", { path: "repo/AGENTS.md" }),
	...call("c5", "mygitnotes-read", { path: "notes/sos-02/npc/ada.md" }),
	...call("c6", "bash", { command: "ls" }),
	{ role: "assistant", content: [{ type: "text", text: "done" }] },
];

function input(previousSummary?: string): JevCompactInput {
	return {
		messagesToSummarize: messages,
		firstKeptEntryId: "kept",
		tokensBefore: 310_000,
		...(previousSummary ? { previousSummary } : {}),
	};
}

const options = (asker: JevAsker = dropAll): JevCompactOptions => ({
	asker,
	config: { apiKey: "sk-test-0000000000", preserveRecentMessages: 1 },
});

const count = (text: string, part: string) => text.split(part).length - 1;

describe("jevCompact", () => {
	test("two compactions in a row keep the previous summary once", async () => {
		const first = await jevCompact(input(), options());
		if (!("compaction" in first)) throw new Error(first.skipped);
		const previous = first.compaction.summary.trim();
		const second = await jevCompact(input(previous), options());
		if (!("compaction" in second)) throw new Error(second.skipped);
		const summary = second.compaction.summary;
		expect(count(summary, previous)).toBe(1);
		expect(count(summary, "[previous compaction]")).toBe(1);
		expect(summary).not.toContain("## Previous compaction");
		expect(second.compaction.estimatedTokensAfter).toBe(
			Math.ceil(summary.length / 4),
		);
		expect(second.compaction.details?.engine).toBe(JEV_COMPACTION_ENGINE);
	});

	test("a previous summary past the limit skips without asking Jev", async () => {
		let asked = false;
		const outcome = await jevCompact(
			input("x".repeat(JEV_PREVIOUS_SUMMARY_LIMIT_TOKENS * 4 + 8)),
			options({
				ask: async (state, questions) => {
					asked = true;
					return dropAll.ask(state, questions);
				},
			}),
		);
		expect(outcome).toEqual({ skipped: "previous_summary_too_large" });
		expect(asked).toBe(false);
	});

	test("the limit is an option", async () => {
		const outcome = await jevCompact(input("y".repeat(400)), {
			...options(),
			previousSummaryLimitTokens: 50,
		});
		expect(outcome).toEqual({ skipped: "previous_summary_too_large" });
	});

	test("the reload list names skills, system prompts and rule-file reads, not ordinary reads or bash", async () => {
		const outcome = await jevCompact(input(), options());
		if (!("compaction" in outcome)) throw new Error(outcome.skipped);
		const reloads = outcome.compaction.summary.split(
			"## Rules loaded before this compaction",
		)[1];
		expect(reloads).toContain(
			'`mygitnotes-invoke-skill` {"name":"session-prep"}',
		);
		expect(reloads).toContain("`mygitnotes-get-system-prompt`");
		expect(reloads).toContain("prep/SKILL.md");
		expect(reloads).toContain("repo/AGENTS.md");
		expect(reloads).not.toContain("npc/ada.md");
		expect(reloads).not.toContain("bash");
	});

	test("the reload matcher is an option", async () => {
		const outcome = await jevCompact(input(), {
			...options(),
			ruleLoad: (tool) => tool === "bash",
		});
		if (!("compaction" in outcome)) throw new Error(outcome.skipped);
		const reloads = outcome.compaction.summary.split(
			"## Rules loaded before this compaction",
		)[1];
		expect(reloads).toContain('`bash` {"command":"ls"}');
		expect(reloads).not.toContain("invoke-skill");
	});

	test("Jev's goal defaults to keeping rules and may be overridden", async () => {
		const goals: string[] = [];
		const recording = (asker: JevAsker): JevAsker => ({
			ask: async (state, questions) => {
				goals.push(JSON.stringify(state));
				return asker.ask(state, questions);
			},
		});
		await jevCompact(input(), options(recording(dropAll)));
		await jevCompact(input(), {
			...options(recording(dropAll)),
			goal: "only the ledger",
		});
		expect(goals[0]).toContain("notebook system prompts");
		expect(goals.at(-1)).toContain("only the ledger");
	});

	test("a Jev failure skips", async () => {
		const outcome = await jevCompact(input(), options(failing));
		expect(outcome).toEqual({ skipped: "jev_error", detail: "Jev is down" });
	});

	test("an aborted compaction skips", async () => {
		const controller = new AbortController();
		controller.abort();
		const outcome = await jevCompact(
			{ ...input(), signal: controller.signal },
			options(),
		);
		expect(outcome).toEqual({ skipped: "aborted" });
	});
});

type Handler = (event: SessionBeforeCompactEvent) => Promise<unknown>;

function load(factory: ExtensionFactory): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
	} as unknown as ExtensionAPI;
	void factory(pi);
	return handlers;
}

function compactEvent(previousSummary?: string): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "kept",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 310_000,
			previousSummary,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: {
				enabled: true,
				reserveTokens: 16_384,
				keepRecentTokens: 20_000,
			},
		},
		branchEntries: [],
		reason: "threshold",
		signal: new AbortController().signal,
	} as unknown as SessionBeforeCompactEvent;
}

describe("jevCompactionExtension", () => {
	test("registers only session_before_compact and goes through the session's wrap", async () => {
		const wrapped: ExtensionFactory[] = [];
		const session = {
			compaction: {
				wrap: (compactor: ExtensionFactory): ExtensionFactory => {
					wrapped.push(compactor);
					return compactor;
				},
			},
		};
		const { logger, lines } = recordingLogger();
		const handlers = load(
			session.compaction.wrap(
				jevCompactionExtension({
					logger,
					...options(),
				}),
			),
		);
		expect(wrapped).toHaveLength(1);
		expect([...handlers.keys()]).toEqual(["session_before_compact"]);
		const answer = (await handlers.get("session_before_compact")?.(
			compactEvent(),
		)) as { compaction: { summary: string } };
		expect(answer.compaction.summary).toContain(
			"## Rules loaded before this compaction",
		);
		expect(lines).toEqual([]);
	});

	test("a skip returns nothing and logs its reason and tokensBefore", async () => {
		const { logger, lines } = recordingLogger();
		const handlers = load(
			jevCompactionExtension({
				logger,
				...options(failing),
			}),
		);
		expect(
			await handlers.get("session_before_compact")?.(compactEvent()),
		).toBeUndefined();
		expect(lines).toEqual([
			{
				level: "info",
				fields: {
					reason: "jev_error",
					detail: "Jev is down",
					tokensBefore: 310_000,
				},
				message: "Jev leaves the compaction to Pi's summary",
			},
		]);
	});
});

/** No key and no asker, as on a host without Jev; the tests run without a Jev key in the environment. */
/** No key, and a service address only these tests use, so their fetch counter sees no other test's calls. */
const JEV_TEST_URL = "https://jev.invalid";
const keyless: JevCompactOptions = {
	config: { apiKey: "", baseUrl: JEV_TEST_URL },
};

const NO_KEY_LINE = {
	level: "info" as const,
	fields: { reason: "no_key" },
	message: "Jev is not configured, so compaction uses Pi's summary",
};

/** Runs `body` with fetch counting calls to Jev's service, so a test sees that it was not asked. */
async function withoutJevCalls(body: () => Promise<void>): Promise<void> {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			if (!url.startsWith(JEV_TEST_URL)) return original(input, init);
			calls++;
			throw new Error("Jev must not be asked");
		},
		{ preconnect: original.preconnect },
	) as typeof fetch;
	try {
		await body();
	} finally {
		globalThis.fetch = original;
	}
	expect(calls).toBe(0);
}

describe("jevCompactionExtension without a key", () => {
	test("logs once and leaves every compaction to Pi's summary", async () => {
		await withoutJevCalls(async () => {
			const { logger, lines } = recordingLogger();
			const handlers = load(jevCompactionExtension({ logger, ...keyless }));
			for (let i = 0; i < 2; i++)
				expect(
					await handlers.get("session_before_compact")?.(compactEvent()),
				).toBeUndefined();
			expect(lines).toEqual([NO_KEY_LINE]);
		});
	});
});

describe("jevCompactor", () => {
	const request = (previousSummary?: string) => ({
		reason: "threshold" as const,
		tokensBefore: 310_000,
		firstKeptEntryId: "kept",
		isSplitTurn: false,
		messagesToSummarize: messages as ({ role: string } & Record<
			string,
			unknown
		>)[],
		turnPrefixMessages: [],
		keptMessages: [],
		readFiles: [],
		modifiedFiles: [],
		...(previousSummary ? { previousSummary } : {}),
	});
	const context = {
		channel: "discord:1:2" as ChannelKey,
		signal: new AbortController().signal,
	};

	test("returns Jev's compaction", async () => {
		const { logger, lines } = recordingLogger();
		const compactor = jevCompactor({
			logger,
			...options(),
		});
		expect(compactor.engine).toBe("pi-jev-compaction");
		const compaction = await compactor.compact(request(), context);
		expect(compaction?.firstKeptEntryId).toBe("kept");
		expect(lines).toEqual([]);
	});

	test("returns undefined and logs the skip with its channel", async () => {
		const { logger, lines } = recordingLogger();
		const compactor = jevCompactor({
			logger,
			...options(),
		});
		const compaction = await compactor.compact(
			request("z".repeat(JEV_PREVIOUS_SUMMARY_LIMIT_TOKENS * 4 + 8)),
			context,
		);
		expect(compaction).toBeUndefined();
		expect(lines).toEqual([
			{
				level: "info",
				fields: {
					channel: "discord:1:2",
					reason: "previous_summary_too_large",
					detail: undefined,
					tokensBefore: 310_000,
				},
				message: "Jev leaves the compaction to Pi's summary",
			},
		]);
	});
});

describe("jevCompactor without a key", () => {
	test("logs once and leaves every compaction to Pi's summary", async () => {
		await withoutJevCalls(async () => {
			const { logger, lines } = recordingLogger();
			const compactor = jevCompactor({ logger, ...keyless });
			const context = {
				channel: "discord:1:2" as ChannelKey,
				signal: new AbortController().signal,
			};
			const request = {
				reason: "threshold",
				tokensBefore: 310_000,
				firstKeptEntryId: "kept",
				messagesToSummarize: messages,
				turnPrefixMessages: [],
				keptMessages: [],
				readFiles: [],
				modifiedFiles: [],
			};
			for (let i = 0; i < 2; i++)
				expect(await compactor.compact(request, context)).toBeUndefined();
			expect(lines).toEqual([
				{
					...NO_KEY_LINE,
					fields: { channel: "discord:1:2", reason: "no_key" },
				},
			]);
		});
	});
});
