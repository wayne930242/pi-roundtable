import { describe, expect, test } from "bun:test";
import { silentLogger } from "pi-roundtable/testing";
import type { PushPayload, SendResult, Target } from "./sender.ts";
import type { Subscription } from "./subscriptions.ts";
import { PREVIEW_CHARS, PushService, previewOf } from "./triggers.ts";

const device = (endpoint: string, principalId = "ada"): Subscription => ({
	endpoint,
	principalId,
	p256dh: "k",
	auth: "a",
	createdAt: new Date(0),
});

function service(
	options: {
		devices?: Subscription[];
		visible?: string[];
		preview?: boolean;
		answer?: (target: Target) => SendResult;
		tiers?: Record<string, "owner" | "member">;
	} = {},
) {
	const sent: { endpoint: string; payload: PushPayload }[] = [];
	const delivered: string[] = [];
	const forgotten: string[] = [];
	const failed: string[] = [];
	let clock = 1_000_000;
	const instance = new PushService({
		subscriptions: {
			all: async () =>
				options.devices ?? [device("https://fcm.googleapis.com/a")],
			delivered: async (endpoint) => void delivered.push(endpoint),
			forget: async (endpoint) => void forgotten.push(endpoint),
			failed: async (endpoint) => {
				failed.push(endpoint);
				return false;
			},
		},
		sender: {
			send: async (target, payload) => {
				sent.push({ endpoint: target.endpoint, payload });
				return options.answer?.(target) ?? "sent";
			},
		},
		identity: {
			tierOf: async (id) => options.tiers?.[id] ?? "owner",
		},
		visible: (id) => options.visible?.includes(id) ?? false,
		preview: options.preview ?? true,
		urlOf: (room) => `/console/#/room/${room}`,
		logger: silentLogger(),
		now: () => clock,
	});
	return {
		instance,
		sent,
		delivered,
		forgotten,
		failed,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("when a device is pushed", () => {
	test("a waiting card pushes once to a device, with the room and the card's title", async () => {
		const { instance, sent, delivered } = service();
		await instance.card("app:agent.guide", "Send the note?", false);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.payload).toEqual({
			kind: "card",
			title: "Card waiting",
			body: "Send the note?",
			room: "app:agent.guide",
			url: "/console/#/room/app:agent.guide",
			tag: "app:agent.guide",
		});
		expect(delivered).toEqual(["https://fcm.googleapis.com/a"]);
	});

	test("the cap of a long-running room is told as such", async () => {
		const { instance, sent } = service();
		await instance.card("app:agent.guide", "Time limit", true);
		expect(sent[0]?.payload).toMatchObject({
			kind: "cap",
			title: "Long-running cap reached",
		});
	});

	test("nothing is pushed to a person while a page of theirs is in view, but another owner's device is", async () => {
		const { instance, sent } = service({
			devices: [
				device("https://fcm.googleapis.com/ada", "ada"),
				device("https://fcm.googleapis.com/bo", "bo"),
			],
			visible: ["ada"],
		});
		await instance.card("app:agent.guide", "t", false);
		expect(sent.map((s) => s.endpoint)).toEqual([
			"https://fcm.googleapis.com/bo",
		]);
	});

	test("a device of someone who is no owner any more is skipped", async () => {
		const { instance, sent } = service({ tiers: { ada: "member" } });
		await instance.card("app:agent.guide", "t", false);
		expect(sent).toEqual([]);
	});

	test("without previews no text of the message is sent", async () => {
		const { instance, sent } = service({ preview: false });
		await instance.card("app:agent.guide", "rm -rf the secret thing", false);
		await instance.notice("ada", "the password is hunter2", "app:agent.guide");
		expect(sent).toHaveLength(2);
		for (const { payload } of sent) expect(payload.body).toBeUndefined();
		expect(JSON.stringify(sent)).not.toContain("hunter2");
	});

	test("a reply is shown by the author and cut at the preview length; replies in one room close together share one", async () => {
		const { instance, sent, advance } = service();
		await instance.reply("app:agent.guide", "Guide", "x".repeat(500));
		await instance.reply("app:agent.guide", "Guide", "again");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.payload.title).toBe("Guide");
		expect(Array.from(sent[0]?.payload.body ?? "")).toHaveLength(
			PREVIEW_CHARS + 1,
		);
		advance(20_000);
		await instance.reply("app:agent.guide", "Guide", "later");
		expect(sent).toHaveLength(2);
	});

	test("a notice goes to its person's devices only", async () => {
		const { instance, sent } = service({
			devices: [
				device("https://fcm.googleapis.com/ada", "ada"),
				device("https://fcm.googleapis.com/bo", "bo"),
			],
		});
		await instance.notice("bo", "hello");
		expect(sent.map((s) => s.endpoint)).toEqual([
			"https://fcm.googleapis.com/bo",
		]);
	});

	test("a service that says the device is gone drops it; any other failure is counted", async () => {
		const gone = service({ answer: () => "gone" });
		await gone.instance.card("app:agent.guide", "t", false);
		expect(gone.forgotten).toEqual(["https://fcm.googleapis.com/a"]);
		const down = service({ answer: () => "failed" });
		await down.instance.card("app:agent.guide", "t", false);
		expect(down.failed).toEqual(["https://fcm.googleapis.com/a"]);
		expect(down.forgotten).toEqual([]);
	});

	test("a broken subscription store never throws into the turn", async () => {
		const instance = new PushService({
			subscriptions: {
				all: async () => {
					throw new Error("db down");
				},
				delivered: async () => undefined,
				forget: async () => undefined,
				failed: async () => false,
			},
			sender: { send: async () => "sent" },
			identity: { tierOf: async () => "owner" },
			visible: () => false,
			preview: true,
			urlOf: (room) => room,
			logger: silentLogger(),
		});
		await instance.card("app:agent.guide", "t", false);
	});
});

test("a preview is one line", () => {
	expect(previewOf("a\n\n  b\tc")).toBe("a b c");
});
