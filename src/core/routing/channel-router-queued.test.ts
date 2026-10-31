import { describe, expect, test } from "bun:test";
import type {
	Admission,
	ChannelClaim,
	InboundMessage,
} from "../contract/channels.ts";
import { silentLogger } from "../log.ts";
import { mapIdentity } from "../testing/map-identity.ts";
import { ChannelQueue } from "./channel-queue.ts";
import { ChannelRouter } from "./channel-router.ts";

const IDENTITY = mapIdentity({ owners: ["riley", "sam"] });
const RILEY = { principalId: "riley" };
const SAM = { principalId: "sam" };

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		channel: "discord:1",
		messageId: "m1",
		authorId: "riley",
		authorName: "Riley",
		authorIsBot: false,
		isDirect: true,
		mentionsBot: false,
		repliesToBot: false,
		text: "hi",
		attachments: [],
		...overrides,
	};
}

/** A claim whose turns record what they ran, and which marks they placed and removed. */
function setup(
	options: {
		steers?: () => boolean;
		takes?: (m: InboundMessage) => boolean;
		/** The router knows no one, so no message has a speaker. */
		anonymous?: boolean;
	} = {},
) {
	const log: string[] = [];
	const queue = new ChannelQueue();
	const claim: ChannelClaim = {
		name: "owner",
		priority: 0,
		owns: () => true,
		admit: (m): Admission | undefined => {
			if (options.takes && !options.takes(m)) return undefined;
			return {
				kind: "turn",
				busy: {
					steer: async () => options.steers?.() ?? false,
					react: async (emoji) => void log.push(`+${emoji} ${m.text}`),
					unreact: async (emoji) => void log.push(`-${emoji} ${m.text}`),
				},
				run: async () => {
					log.push(`run ${m.text}`);
					if (m.text === "first") await gate.promise;
				},
				dropped: () => void log.push(`dropped ${m.text}`),
				failure: "failed",
			};
		},
		startFresh: async () => "owner",
	};
	const gate = Promise.withResolvers<void>();
	const routing = new ChannelRouter({
		claims: [claim],
		targets: () => undefined,
		queue,
		logger: silentLogger(),
		...(options.anonymous ? {} : { contacts: IDENTITY, principals: IDENTITY }),
	});
	return { log, queue, routing, release: gate.resolve };
}

/** A running first turn and a second message waiting behind it. */
async function waiting(setupOptions: Parameters<typeof setup>[0] = {}) {
	const world = setup(setupOptions);
	const first = world.routing.handle(
		message({ text: "first", messageId: "a" }),
	);
	await Bun.sleep(1);
	const second = world.routing.handle(
		message({ text: "second", messageId: "b" }),
	);
	await Bun.sleep(1);
	return { ...world, first, second };
}

describe("queued messages", () => {
	test("lists a message waiting for its turn, with its author and text, until the turn starts", async () => {
		const world = await waiting();
		expect(world.routing.queued("discord:1")).toMatchObject([
			{ messageId: "b", principalId: "riley", text: "second" },
		]);
		expect(world.routing.queued("discord:2")).toEqual([]);
		world.release();
		await Promise.all([world.first, world.second]);
		expect(world.routing.queued("discord:1")).toEqual([]);
		expect(world.log).toEqual([
			"run first",
			"+⏳ second",
			"-⏳ second",
			"run second",
		]);
	});

	test("a steered message is not queued, so it cannot be cancelled or edited", async () => {
		const world = setup({ steers: () => true });
		const first = world.routing.handle(
			message({ text: "first", messageId: "a" }),
		);
		await Bun.sleep(1);
		await world.routing.handle(message({ text: "added", messageId: "b" }));
		expect(world.routing.queued("discord:1")).toEqual([]);
		expect(world.routing.cancelQueued("discord:1", "b", RILEY)).toBe("unknown");
		expect(world.routing.editQueued("discord:1", "b", RILEY, "x")).toBe(
			"unknown",
		);
		world.release();
		await first;
		expect(world.log).toEqual(["run first", "+↪️ added"]);
	});

	test("cancelling a queued message drops it: its turn never runs and its mark goes", async () => {
		const world = await waiting();
		expect(world.routing.cancelQueued("discord:1", "b", RILEY)).toBe("done");
		expect(world.routing.queued("discord:1")).toEqual([]);
		world.release();
		await Promise.all([world.first, world.second]);
		expect(world.log).toEqual([
			"run first",
			"+⏳ second",
			"dropped second",
			"-⏳ second",
		]);
		expect(world.queue.size("discord:1")).toBe(0);
	});

	test("only the author cancels or edits; the others are refused and nothing changes", async () => {
		const world = await waiting();
		expect(world.routing.cancelQueued("discord:1", "b", SAM)).toBe("forbidden");
		expect(world.routing.editQueued("discord:1", "b", SAM, "mine")).toBe(
			"forbidden",
		);
		expect(world.routing.queued("discord:1")).toMatchObject([
			{ text: "second" },
		]);
		world.release();
		await Promise.all([world.first, world.second]);
		expect(world.log.at(-1)).toBe("run second");
	});

	test("a message with no resolved author can be changed by no one", async () => {
		const world = await waiting({ anonymous: true });
		expect(world.routing.queued("discord:1")).toMatchObject([
			{ messageId: "b" },
		]);
		expect(world.routing.queued("discord:1")[0]?.principalId).toBeUndefined();
		expect(world.routing.cancelQueued("discord:1", "b", RILEY)).toBe(
			"forbidden",
		);
		expect(world.routing.editQueued("discord:1", "b", RILEY, "x")).toBe(
			"forbidden",
		);
		world.release();
		await Promise.all([world.first, world.second]);
		expect(world.log.at(-1)).toBe("run second");
	});

	test("an edit gives the turn the new text, through the claim's admission", async () => {
		const world = await waiting();
		expect(world.routing.editQueued("discord:1", "b", RILEY, "changed")).toBe(
			"done",
		);
		expect(world.routing.queued("discord:1")).toMatchObject([
			{ text: "changed" },
		]);
		world.release();
		await Promise.all([world.first, world.second]);
		expect(world.log).toEqual([
			"run first",
			"+⏳ second",
			"dropped second",
			"-⏳ changed",
			"run changed",
		]);
	});

	test("an edit the claim would no longer take is refused and the old text stays", async () => {
		const world = await waiting({ takes: (m) => m.text !== "nope" });
		expect(world.routing.editQueued("discord:1", "b", RILEY, "nope")).toBe(
			"refused",
		);
		world.release();
		await Promise.all([world.first, world.second]);
		expect(world.log.at(-1)).toBe("run second");
	});

	test("once the turn has started, cancel and edit say unknown and change nothing", async () => {
		const world = await waiting();
		world.release();
		await Promise.all([world.first, world.second]);
		expect(world.routing.cancelQueued("discord:1", "b", RILEY)).toBe("unknown");
		expect(world.routing.editQueued("discord:1", "b", RILEY, "late")).toBe(
			"unknown",
		);
		expect(world.log.filter((line) => line.startsWith("run"))).toEqual([
			"run first",
			"run second",
		]);
	});

	test("a cancel and the start race to one winner: a cancel after the start is unknown, never both", async () => {
		const world = await waiting();
		world.release();
		// The first turn ends; the second turn's task runs on the next microtasks, after this call.
		await world.first;
		const result = world.routing.cancelQueued("discord:1", "b", RILEY);
		await world.second;
		const ran = world.log.includes("run second");
		expect(result === "done" ? !ran : ran && result === "unknown").toBe(true);
	});

	test("the surface deleting a queued message cancels it without touching its mark; editing it changes the text", async () => {
		const world = await waiting();
		await world.routing.messageEdited(
			message({ messageId: "b", text: "edited on the surface" }),
		);
		expect(world.routing.queued("discord:1")).toMatchObject([
			{ text: "edited on the surface" },
		]);
		await world.routing.messageDeleted("discord:1", "b");
		expect(world.routing.queued("discord:1")).toEqual([]);
		world.release();
		await Promise.all([world.first, world.second]);
		expect(world.log).toEqual([
			"run first",
			"+⏳ second",
			"dropped second",
			"dropped edited on the surface",
		]);
	});

	test("a deleted or edited message that is not queued is ignored", async () => {
		const world = setup();
		await world.routing.messageDeleted("discord:1", "nothing");
		await world.routing.messageEdited(message({ messageId: "nothing" }));
		expect(world.routing.queued("discord:1")).toEqual([]);
		world.release();
	});

	test("a cancelled message does not get the restart notice when the host stops; a queued one does not run", async () => {
		const world = await waiting();
		world.routing.cancelQueued("discord:1", "b", RILEY);
		world.queue.close();
		world.release();
		await Promise.all([world.first, world.second]);
		expect(world.log).toEqual([
			"run first",
			"+⏳ second",
			"dropped second",
			"-⏳ second",
		]);
		expect(world.routing.queued("discord:1")).toEqual([]);
	});

	test("a queued message still waiting when the host stops leaves the list and is dropped once", async () => {
		const world = await waiting();
		world.queue.close();
		world.release();
		await Promise.all([world.first, world.second]);
		expect(world.routing.queued("discord:1")).toEqual([]);
		expect(world.log).toEqual([
			"run first",
			"+⏳ second",
			"-⏳ second",
			"dropped second",
		]);
	});

	test("a message cancelled while its mark is being placed never runs", async () => {
		const world = setup();
		const marks = Promise.withResolvers<void>();
		let slow = false;
		const claim: ChannelClaim = {
			name: "slow",
			priority: 0,
			owns: () => true,
			admit: (m) => ({
				kind: "turn",
				busy: {
					react: async () => {
						if (slow) await marks.promise;
					},
					unreact: async () => undefined,
				},
				run: async () => {
					world.log.push(`run ${m.text}`);
					if (m.text === "first") await Bun.sleep(5);
				},
				dropped: () => void world.log.push(`dropped ${m.text}`),
				failure: "failed",
			}),
			startFresh: async () => "slow",
		};
		const routing = new ChannelRouter({
			claims: [claim],
			targets: () => undefined,
			queue: new ChannelQueue(),
			logger: silentLogger(),
			contacts: IDENTITY,
			principals: IDENTITY,
		});
		const first = routing.handle(message({ text: "first", messageId: "a" }));
		await Bun.sleep(1);
		slow = true;
		const second = routing.handle(message({ text: "second", messageId: "b" }));
		await Bun.sleep(1);
		expect(routing.cancelQueued("discord:1", "b", RILEY)).toBe("done");
		marks.resolve();
		await Promise.all([first, second]);
		expect(world.log).toEqual(["run first", "dropped second"]);
		world.release();
	});
});
