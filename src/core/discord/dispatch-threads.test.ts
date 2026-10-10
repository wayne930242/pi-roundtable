import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { messages } from "../i18n/index.ts";
import { silentLogger } from "../log.ts";
import { FakeThreadHost, fakeThreads } from "../testing/thread-host.ts";
import { DispatchThreads, threadName } from "./dispatch-threads.ts";

describe("DispatchThreads", () => {
	test("opens a thread under the origin with a start line there and the intro inside", async () => {
		const { host, threads } = fakeThreads();
		const thread = await threads.open(
			"discord:10",
			"research",
			"📋 Task: find it",
		);
		expect(host.opened).toEqual([
			{ parentId: "10", name: "research", id: "900" },
		]);
		expect(host.lines.get("10")).toBe(
			messages().threadStarted("research", "<#900>"),
		);
		expect(thread?.mention).toBe("<#900>");
		expect(host.textsIn("900")).toEqual(["📋 Task: find it"]);
	});

	test("close posts the report, archives once, and forgets the thread", async () => {
		const { host, threads, ledgerPath } = fakeThreads();
		const thread = await threads.open("discord:10", "t");
		expect(Object.keys(JSON.parse(readFileSync(ledgerPath, "utf8")))).toEqual([
			"900",
		]);
		await thread?.close("✅ Done");
		await thread?.close("again");
		expect(host.textsIn("900")).toEqual(["✅ Done"]);
		expect(host.closed).toEqual(["900"]);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toEqual({});
	});

	test("a thread's interim posts go through the host and edit in place", async () => {
		const { host, threads, ledgerPath } = fakeThreads();
		const thread = await threads.open("discord:10", "t");
		const message = await thread?.interim?.post("-# read");
		await message?.edit("-# read · bash");
		expect(host.textsIn("900")).toEqual(["-# read · bash"]);
		expect(host.edits).toEqual([{ threadId: "900", text: "-# read · bash" }]);
		const plain = await new DispatchThreads({
			host: {
				open: async () => "901",
				post: async () => {},
				close: async () => {},
			},
			ledgerPath: `${ledgerPath}.bare`,
			logger: silentLogger(),
		}).open("discord:10", "t");
		expect(plain?.interim).toBeUndefined();
	});

	test("no thread outside Discord, in excluded channels, where the host cannot, or when creation fails", async () => {
		const host = new FakeThreadHost();
		host.hostless.add("20");
		const { threads, ledgerPath } = fakeThreads(host);
		const bare = new DispatchThreads({
			host,
			ledgerPath,
			excluded: (channel) => channel === "discord:30",
			logger: silentLogger(),
		});
		expect(await threads.open(undefined, "t")).toBeUndefined();
		expect(await threads.open("mcp:abc", "t")).toBeUndefined();
		expect(await threads.open("discord:20", "t")).toBeUndefined();
		expect(await bare.open("discord:30", "t")).toBeUndefined();
		host.failOpen = true;
		expect(await threads.open("discord:40", "t")).toBeUndefined();
		expect(host.opened).toEqual([]);
	});

	test("a failed post or archive is logged, not thrown", async () => {
		const host = new FakeThreadHost();
		host.post = async () => {
			throw new Error("gone");
		};
		host.close = async () => {
			throw new Error("gone");
		};
		const { threads } = fakeThreads(host);
		const thread = await threads.open("discord:10", "t", "intro");
		await thread?.post("x");
		await thread?.close("report");
	});

	test("a start after a restart archives the threads left open, with a notice", async () => {
		const { host, threads, ledgerPath } = fakeThreads();
		await threads.open("discord:10", "a");
		const done = await threads.open("discord:11", "b");
		await done?.close();
		const restarted = new DispatchThreads({
			host,
			ledgerPath,
			logger: silentLogger(),
		});
		await restarted.sweep();
		expect(host.closed).toEqual(["901", "900"]);
		expect(host.textsIn("900")).toEqual([messages().restartNotice]);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toEqual({});
	});

	test("thread names are one line within Discord's 100 characters", () => {
		expect(threadName(" a\nb ")).toBe("a b");
		const long = threadName("x".repeat(150));
		expect(long.length).toBe(100);
		expect(long.endsWith("…")).toBe(true);
	});
});
