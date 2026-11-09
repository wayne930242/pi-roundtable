import { afterEach, expect, test } from "bun:test";
import { fakeThreads, silentLogger } from "pi-roundtable/testing";
import { CodingDesk, type CodingResult } from "./coding-desk.ts";
import { request, stops } from "./testing/coding-fixture.ts";
import { fixture, removeTemp } from "./testing/repo-fixture.ts";

afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
	removeTemp();
});

test("threads own approval cards, archive before result delivery, and never fall back when absent", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	for (const origin of ["discord:origin", undefined] as const) {
		const { host, threads } = fakeThreads();
		const asked: string[] = [];
		const results: CodingResult[] = [];
		const desk = new CodingDesk({
			shelf,
			threads,
			logger: silentLogger(),
			threadText: {
				initial: (job) => `Start ${job.task}`,
				held: () => "Awaiting approval",
				approvalTitle: () => "Host approval",
				report: () => "Host report",
			},
			prompts: (channel) => ({
				confirm: async (title) => {
					asked.push(`${channel}: ${title}`);
					return "expired";
				},
				ask: async () => undefined,
			}),
			worker: {
				run: async (_job, _signal, review) =>
					`${await review({ tool: "bash", input: "{}", action: "push" })}`,
			},
			deliver: async (result) => {
				if (origin) expect(host.closed).toEqual(["900"]);
				results.push(result);
			},
		});
		await desk.start({ ...request(), origin });
		await desk.idle();
		if (origin) {
			expect(host.opened[0]?.parentId).toBe("origin");
			expect(asked).toEqual(["discord:900: Host approval"]);
			expect(host.textsIn("900")).toEqual([
				"Start Implement the contract",
				"Awaiting approval",
				"Host report",
			]);
		} else expect(asked).toEqual([]);
		expect(results[0]?.outcome).toEqual({ ok: true, report: "held" });
		await desk.stop();
	}
});

test("a worker posts its progress into its thread, cards after it, and its report once", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	const proposal = `## Plan\n${"Change the parser. ".repeat(30)}`;
	for (const interimText of ["on", "off"] as const) {
		const { host, threads } = fakeThreads();
		const desk = new CodingDesk({
			shelf,
			threads,
			logger: silentLogger(),
			interimText,
			prompts: (channel) => ({
				confirm: async () => {
					host.posts.push({ threadId: channel, text: "card" });
					return "approved";
				},
				ask: async () => undefined,
			}),
			worker: {
				run: async (_job, _signal, review, progress) => {
					progress?.messageEnd({
						role: "assistant",
						stopReason: "toolUse",
						content: proposal,
					});
					progress?.toolStart("read");
					progress?.messageEnd({
						role: "assistant",
						stopReason: "toolUse",
						content: "Running the tests.",
					});
					progress?.toolStart("bash");
					progress?.toolStart("bash");
					await review({ tool: "bash", input: "{}", action: "push" });
					progress?.messageEnd({
						role: "assistant",
						stopReason: "stop",
						content: "Final report",
					});
					return "Final report";
				},
			},
			deliver: async () => {},
		});
		await desk.start({ ...request(), origin: "discord:origin" });
		await desk.idle();
		const texts = host.textsIn("900");
		const report = texts.at(-1) ?? "";
		expect(report).toContain("Final report");
		expect(texts.filter((text) => text.includes("Final report"))).toHaveLength(
			1,
		);
		if (interimText === "off") {
			expect(texts).toHaveLength(2);
			expect(host.posts.map((post) => post.text)).toContain("card");
		} else {
			expect(texts.slice(1, 3)).toEqual([
				proposal.trim(),
				"-# Running the tests.\n-# read · bash ×2",
			]);
			// The progress message was edited in place, not posted again.
			expect(host.edits.length).toBeGreaterThan(0);
			const order = host.posts.map((post) => post.text);
			expect(order.indexOf("card")).toBeGreaterThan(
				order.indexOf("-# Running the tests.\n-# read · bash ×2"),
			);
		}
		await desk.stop();
	}
});

test("a failed progress post never fails the coding job", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	const delivered: CodingResult[] = [];
	const desk = new CodingDesk({
		shelf,
		logger: silentLogger(),
		threads: {
			open: async () => ({
				id: "1",
				channel: "test:thread",
				mention: "#1",
				post: async () => {},
				interim: {
					post: async () => {
						throw new Error("offline");
					},
				},
				close: async () => {},
			}),
		},
		worker: {
			run: async (_job, _signal, _review, progress) => {
				progress?.messageEnd({
					role: "assistant",
					stopReason: "toolUse",
					content: "x".repeat(500),
				});
				progress?.toolStart("bash");
				return "done";
			},
		},
		deliver: async (result) => {
			delivered.push(result);
		},
	});
	await desk.start(request());
	await desk.idle();
	expect(delivered[0]?.outcome).toEqual({ ok: true, report: "done" });
	await desk.stop();
});

test("thread failures cannot discard the worker result", async () => {
	const { shelf } = await fixture();
	await shelf.add("sample/project");
	const delivered: CodingResult[] = [];
	const desk = new CodingDesk({
		shelf,
		logger: silentLogger(),
		threads: {
			open: async () => ({
				id: "1",
				channel: "test:thread",
				mention: "#1",
				post: async () => {
					throw new Error("offline");
				},
				close: async () => {
					throw new Error("offline");
				},
			}),
		},
		worker: {
			run: async (_job, _signal, review) =>
				`${await review({ tool: "bash", input: "{}", action: "push" })}`,
		},
		deliver: async (result) => {
			delivered.push(result);
		},
	});
	await desk.start(request());
	await desk.idle();
	expect(delivered[0]?.outcome).toEqual({ ok: true, report: "held" });
	expect(delivered[0]?.held).toHaveLength(1);
	await desk.stop();
});
