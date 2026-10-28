import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatSurface, channelKey } from "../contract/surface.ts";
import { messages } from "../i18n/index.ts";
import { type Logger, silentLogger } from "../log.ts";
import { surfacePort } from "../routing/surface-port.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
import { FakeSurfaceThreads } from "../testing/surface-threads.ts";
import { FakeThreadHost, fakeThreads } from "../testing/thread-host.ts";
import { DispatchThreads, threadName } from "./dispatch-threads.ts";

/** A surface that hosts threads through `threads`, or none when it is left out. */
function surfaceOf(
	prefix: string,
	threads?: ChatSurface["threads"],
): ChatSurface {
	return {
		surface: prefix,
		start: async () => undefined,
		sendReply: async () => undefined,
		...(threads ? { threads } : {}),
	};
}

/** Dispatch threads over the given surfaces, with a ledger in a fresh temporary directory. */
function overSurfaces(surfaces: ChatSurface[], ledgerPath = newLedger()) {
	const build = (logger: Logger = silentLogger()) =>
		new DispatchThreads({
			surfaces: surfacePort(() => surfaces),
			ledgerPath,
			logger,
		});
	return { ledgerPath, threads: build(), build };
}

const newLedger = () =>
	join(mkdtempSync(join(tmpdir(), "roundtable-threads-")), "ledger.json");

const ledgerOf = (path: string) => JSON.parse(readFileSync(path, "utf8"));

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
		expect(thread?.id).toBe("900");
		expect(thread?.channel).toBe("discord:900");
		expect(thread?.mention).toBe("<#900>");
		expect(host.textsIn("900")).toEqual(["📋 Task: find it"]);
	});

	test("close posts the report, archives once, and forgets the thread", async () => {
		const { host, threads, ledgerPath } = fakeThreads();
		const thread = await threads.open("discord:10", "t");
		expect(Object.keys(ledgerOf(ledgerPath))).toEqual(["discord:900"]);
		await thread?.close("✅ Done");
		await thread?.close("again");
		expect(host.textsIn("900")).toEqual(["✅ Done"]);
		expect(host.closed).toEqual(["900"]);
		expect(ledgerOf(ledgerPath)).toEqual({});
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

	test("no thread outside a surface that hosts them, in excluded channels, where the host cannot, or when creation fails", async () => {
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
		expect(ledgerOf(ledgerPath)).toEqual({});
	});

	test("thread names are one line within Discord's 100 characters", () => {
		expect(threadName(" a\nb ")).toBe("a b");
		const long = threadName("x".repeat(150));
		expect(long.length).toBe(100);
		expect(long.endsWith("…")).toBe(true);
	});
});

describe("dispatch threads on a surface other than Discord", () => {
	test("an origin on the app surface opens its thread there, as the channel app:<id>, with a ledger entry", async () => {
		const app = new FakeSurfaceThreads();
		const { threads, ledgerPath } = overSurfaces([surfaceOf("app", app)]);
		const thread = await threads.open(
			"app:agent.x",
			"research",
			"📋 Task: find it",
		);
		expect(app.opened).toEqual([
			{ parent: "app:agent.x", name: "research", id: "thread.1" },
		]);
		expect(app.lines.get("app:agent.x")).toBe(
			messages().threadStarted("research", "research"),
		);
		expect(thread?.id).toBe("thread.1");
		expect(thread?.channel).toBe(channelKey("app", "thread.1"));
		expect(thread?.channel).toBe("app:thread.1");
		expect(thread?.mention).toBe("research");
		expect(app.textsIn("thread.1")).toEqual(["📋 Task: find it"]);
		expect(ledgerOf(ledgerPath)).toEqual({
			"app:thread.1": {
				title: "research",
				parent: "app:agent.x",
				startedAt: expect.any(String),
			},
		});
	});

	test("close posts the report and archives through the same surface, once", async () => {
		const app = new FakeSurfaceThreads();
		const { threads, ledgerPath } = overSurfaces([surfaceOf("app", app)]);
		const thread = await threads.open("app:agent.x", "t");
		await thread?.close("✅ Done");
		await thread?.close("again");
		expect(app.textsIn("thread.1")).toEqual(["✅ Done"]);
		expect(app.closed).toEqual(["thread.1"]);
		expect(ledgerOf(ledgerPath)).toEqual({});
	});

	test("the sweep after a restart closes each app thread through the app surface, with a notice", async () => {
		const app = new FakeSurfaceThreads();
		const shared = newLedger();
		const first = overSurfaces([surfaceOf("app", app)], shared);
		await first.threads.open("app:agent.x", "a");
		await first.threads.open("app:group.g", "b");
		expect(Object.keys(ledgerOf(shared))).toEqual([
			"app:thread.1",
			"app:thread.2",
		]);
		await first.build().sweep();
		expect(app.closed).toEqual(["thread.1", "thread.2"]);
		expect(app.textsIn("thread.1")).toEqual([messages().restartNotice]);
		expect(ledgerOf(shared)).toEqual({});
	});

	test("each origin is served by the surface its prefix names", async () => {
		const app = new FakeSurfaceThreads();
		const other = new FakeSurfaceThreads();
		const { threads } = overSurfaces([
			surfaceOf("app", app),
			surfaceOf("other", other),
		]);
		const inApp = await threads.open("app:agent.x", "a");
		const inOther = await threads.open("other:room", "b");
		expect(inApp?.channel).toBe("app:thread.1");
		expect(inOther?.channel).toBe("other:thread.1");
		expect(app.opened.map((o) => o.parent)).toEqual(["app:agent.x"]);
		expect(other.opened.map((o) => o.parent)).toEqual(["other:room"]);
	});

	test("an app thread's interim posts edit in place", async () => {
		const app = new FakeSurfaceThreads();
		const { threads } = overSurfaces([surfaceOf("app", app)]);
		const thread = await threads.open("app:agent.x", "t");
		const message = await thread?.interim?.post("-# read");
		await message?.edit("-# read · bash");
		expect(app.textsIn("thread.1")).toEqual(["-# read · bash"]);
		expect(app.edits).toEqual([{ thread: "thread.1", text: "-# read · bash" }]);
	});

	test("no thread where the surface hosts none, the parent cannot, creation fails, or the channel is excluded", async () => {
		const app = new FakeSurfaceThreads();
		app.hostless.add("app:thread.old");
		const surfaces = [surfaceOf("app", app), surfaceOf("plain")];
		const { ledgerPath, threads } = overSurfaces(surfaces);
		const excluding = new DispatchThreads({
			surfaces: surfacePort(() => surfaces),
			ledgerPath,
			excluded: (channel) => channel === "app:agent.quiet",
			logger: silentLogger(),
		});
		expect(await threads.open("plain:1", "t")).toBeUndefined();
		expect(await threads.open("unknown:1", "t")).toBeUndefined();
		expect(await threads.open("app:thread.old", "t")).toBeUndefined();
		expect(await excluding.open("app:agent.quiet", "t")).toBeUndefined();
		app.failOpen = true;
		expect(await threads.open("app:agent.x", "t")).toBeUndefined();
		expect(app.opened).toEqual([]);
	});

	test("a failed post or archive on a surface is logged, not thrown", async () => {
		const app = new FakeSurfaceThreads();
		app.post = async () => {
			throw new Error("gone");
		};
		app.close = async () => {
			throw new Error("gone");
		};
		const { threads, ledgerPath } = overSurfaces([surfaceOf("app", app)]);
		const thread = await threads.open("app:agent.x", "t", "intro");
		await thread?.post("x");
		await thread?.close("report");
		expect(ledgerOf(ledgerPath)).toEqual({});
	});

	test("a ledger written by 0.22, keyed by Discord thread id, is swept through Discord", async () => {
		const discordThreads = new FakeSurfaceThreads();
		const ledgerPath = newLedger();
		writeFileSync(
			ledgerPath,
			JSON.stringify({
				"123": {
					title: "old",
					parent: "discord:10",
					startedAt: new Date().toISOString(),
				},
			}),
		);
		const { threads } = overSurfaces(
			[surfaceOf("discord", discordThreads)],
			ledgerPath,
		);
		await threads.sweep();
		expect(discordThreads.closed).toEqual(["123"]);
		expect(discordThreads.textsIn("123")).toEqual([messages().restartNotice]);
		expect(ledgerOf(ledgerPath)).toEqual({});
	});

	test("the sweep drops, with a warning, a thread whose surface no longer hosts threads", async () => {
		const app = new FakeSurfaceThreads();
		const ledgerPath = newLedger();
		await overSurfaces([surfaceOf("app", app)], ledgerPath).threads.open(
			"app:agent.x",
			"t",
		);
		const recorded = recordingLogger();
		await overSurfaces([surfaceOf("app")], ledgerPath)
			.build(recorded.logger)
			.sweep();
		expect(app.closed).toEqual([]);
		expect(ledgerOf(ledgerPath)).toEqual({});
		expect(
			recorded.lines
				.filter((line) => line.level === "warn")
				.map((line) => line.message),
		).toEqual(["dispatch thread dropped: its surface hosts no threads"]);
	});

	test("options name the surfaces or the deprecated host, and exactly one", () => {
		const ledgerPath = newLedger();
		const logger = silentLogger();
		expect(() => new DispatchThreads({ ledgerPath, logger } as never)).toThrow(
			"surfaces",
		);
		expect(
			() =>
				new DispatchThreads({
					ledgerPath,
					logger,
					surfaces: surfacePort(() => []),
					host: new FakeThreadHost(),
				}),
		).toThrow("not both");
	});
});
