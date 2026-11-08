import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { AGENTS, THREADS } from "pi-roundtable";
import { describeDb } from "pi-roundtable/testing";
import type { ServerFrame } from "../api-types.ts";
import {
	isThreadKey,
	messagesOf,
	OWNER_SCOPE,
	roomList,
	until,
} from "../testing/app-fixture.ts";
import {
	ADA,
	ADA_DISCORD,
	activity,
	type Booted,
	boot,
	Client,
	ENTRY_CHANNEL,
	GUIDE,
	GUILD,
	ORIGIN,
	ofType,
	rest,
	SCOUT,
} from "../testing/app-host.ts";

describeDb("dispatch threads of the app over a real host", () => {
	let app: Booted;
	beforeAll(async () => {
		app = await boot({ auth: "verifier", graceSeconds: 0.4 });
	}, 30_000);
	afterAll(async () => {
		await app.stop();
	});
	afterEach(() => app.reset());

	test("message_agent from a web room shows the exchange as cards in the sender's room, kept in its history, and opens no thread", async () => {
		app.scripts.set("ask-the-scout", async (request) => {
			// The team's `message_agent` entry is the host's own; the public type leaves it out.
			const team = app.host.context.services.get(AGENTS).team as unknown as {
				message(
					caller: { name: string; session: string; home: string },
					to: string,
					text: string,
				): string;
			};
			if (request.agent?.name === "guide")
				team.message(
					{ name: "guide", session: GUIDE, home: GUIDE },
					"scout",
					"check the disk\nand the logs",
				);
			return { ok: true, text: "asked" };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		const threadsBefore = (await roomList(app)).filter(
			(r) => r.kind === "thread" && r.parent === GUIDE,
		).length;
		tab.send({ type: "send", id: "t1", room: GUIDE, text: "ask-the-scout" });
		const card = (kind: string) =>
			tab.take(
				(f): f is Extract<ServerFrame, { type: "message" }> =>
					f.type === "message" &&
					f.room === GUIDE &&
					f.message.intercom?.kind === kind,
			);
		// The request, under the sender's name, then the answer under the target's.
		const sent = await card("sent");
		expect(sent.message).toMatchObject({
			kind: "agent",
			agent: "guide",
			author: "Guide",
			text: "check the disk\nand the logs",
			intercom: { kind: "sent", peer: { name: "scout", displayName: "Scout" } },
		});
		const answered = await card("answered");
		expect(answered.message).toMatchObject({
			kind: "agent",
			agent: "scout",
			author: "Scout",
			intercom: {
				kind: "answered",
				peer: { name: "scout", displayName: "Scout" },
			},
		});
		expect(answered.message.text).toContain("check the disk");
		// The cards come back with the room's history, as a reload reads it.
		const stored = (await messagesOf(app, GUIDE)).filter(
			(m) => m.id >= sent.message.id && m.intercom,
		);
		expect(stored.map((m) => [m.id, m.intercom?.kind])).toEqual([
			[sent.message.id, "sent"],
			[answered.message.id, "answered"],
		]);
		// No thread was opened for the exchange.
		expect(
			(await roomList(app)).filter(
				(r) => r.kind === "thread" && r.parent === GUIDE,
			),
		).toHaveLength(threadsBefore);
		tab.close();
	});

	test("a thread takes no message from the page, has no modes, and cannot itself host a thread", async () => {
		const threads = app.host.context.services.get(THREADS);
		const thread = await threads.open(GUIDE, "Read only");
		if (!thread) throw new Error("the thread was not opened");
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "ro", room: thread.channel, text: "hi" });
		expect(await tab.take(ofType("refused"))).toMatchObject({
			id: "ro",
			code: "read_only",
		});
		const mode = await rest(
			app,
			`rooms/${encodeURIComponent(thread.channel)}/mode`,
			{ method: "PUT", body: JSON.stringify({ yolo: true }) },
		);
		expect(mode.status).toBe(404);
		expect(await threads.open(thread.channel, "Nested")).toBeUndefined();
		expect(await threads.open("app:agent.nobody", "Nowhere")).toBeUndefined();
		await thread.close();
		tab.close();
	});

	test("a card of a coding job in a thread reaches the owner there and is answered there", async () => {
		const threads = app.host.context.services.get(THREADS);
		const thread = await threads.open(GUIDE, "Coding #7", "📋 Task: tidy");
		if (!thread) throw new Error("the thread was not opened");
		expect(isThreadKey(thread.channel)).toBe(true);
		expect(thread.mention).toContain(thread.channel);
		const one = await Client.open(app, { "x-actor": "owner" });
		const two = await Client.open(app, { "x-actor": "owner" });
		if (!one || !two) throw new Error("the owner was refused");
		await one.take(ofType("ready"));
		const prompts = app.host.context.surfaces.prompts(
			thread.channel,
			OWNER_SCOPE,
		);
		const answer = prompts?.confirm(
			"Push it?",
			"Push the branch",
			undefined,
			"owner",
			undefined,
			{ action: "git push", tool: "bash", input: { command: "git push" } },
		);
		const shown = await one.take(ofType("prompt"));
		expect(shown.room).toBe(thread.channel);
		expect((await two.take(ofType("prompt"))).prompt.id).toBe(shown.prompt.id);
		// The card is answered from the thread's room, which is read only for messages.
		two.send({ type: "approval", prompt: shown.prompt.id, approved: true });
		expect(await one.take(ofType("prompt_closed"))).toMatchObject({
			prompt: shown.prompt.id,
			outcome: "approved",
		});
		expect(await answer).toBe("approved");
		// The task intro and the report are in the thread, then it closes.
		await thread.close("✅ Done");
		const rows = await messagesOf(app, thread.channel);
		expect(rows.map((m) => m.text)).toEqual(["📋 Task: tidy", "✅ Done"]);
		expect(
			(await roomList(app)).find((r) => r.key === thread.channel),
		).toMatchObject({ closed: true, parent: GUIDE });
		one.close();
		two.close();
	});
});

describeDb("dispatch threads left open by a host that stopped", () => {
	test("the next start closes them with a restart notice, and the thread stays readable", async () => {
		const first = await boot({ auth: "verifier" });
		const { dataDir } = first;
		let channel = "";
		try {
			const thread = await first.host.context.services
				.get(THREADS)
				.open(GUIDE, "Left open", "📋 Task: long job");
			if (!thread) throw new Error("the thread was not opened");
			channel = thread.channel;
			expect(
				(await roomList(first)).find((r) => r.key === channel)?.closed,
			).toBeUndefined();
		} finally {
			await first.stop();
		}
		const second = await boot({ auth: "verifier", dataDir });
		try {
			const closed = await until(async () =>
				(await roomList(second)).find((r) => r.key === channel && r.closed),
			);
			expect(closed.parent).toBe(GUIDE);
			const rows = await messagesOf(second, channel);
			expect(rows.map((m) => m.kind)).toEqual(["agent", "system"]);
			expect(rows[1]?.text).toContain("restarted before this job finished");
			expect(rows[1]?.text.startsWith("-#")).toBe(false);
		} finally {
			await second.stop();
		}
	}, 30_000);
});

describeDb("characters and presence over a real host", () => {
	let app: Booted;
	beforeAll(async () => {
		app = await boot({ auth: "verifier", graceSeconds: 0.4 });
	}, 30_000);
	afterAll(async () => {
		await app.stop();
	});
	afterEach(() => app.reset());

	const open = async () => {
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		await tab.take(ofType("ready"));
		return tab;
	};
	const put = (who: string, body: unknown, origin: string | null = ORIGIN) =>
		rest(app, "agents/guide/character", {
			method: "PUT",
			who,
			origin,
			body: JSON.stringify(body),
		});

	test("the room list gives an agent room its character", async () => {
		const rooms = await roomList(app);
		const room = rooms.find((r) => r.key === GUIDE);
		expect(room?.character?.class).toBeString();
		expect(room?.character?.v).toBe(1);
		const profile = (await (await rest(app, "agents/guide")).json()) as {
			character: { class: string };
		};
		expect(profile.character.class).toBe(room?.character?.class as string);
	});

	test("PUT character dresses the agent, shows a changed frame, and refuses what it must", async () => {
		const tab = await open();
		const ok = await put("owner", { character: { palette: "teal" } });
		expect(ok.status).toBe(200);
		const profile = (await ok.json()) as {
			character: { palette?: string; colors: { primary: string } };
		};
		expect(profile.character.palette).toBe("teal");
		await tab.take(ofType("changed"));
		const room = (await roomList(app)).find((r) => r.key === GUIDE);
		expect(room?.character?.palette).toBe("teal");
		const bad = await put("owner", { character: { hat: "no-such-hat" } });
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ field: "hat" });
		expect((await put("owner", { character: [] })).status).toBe(400);
		expect((await put("owner", { palette: "teal" })).status).toBe(400);
		expect(
			(await put("owner", { character: {} }, "https://evil.test")).status,
		).toBe(403);
		expect((await put("owner", { character: {} }, null)).status).toBe(403);
		// The verifier's refusal is a 403, as for every route of the app.
		expect(
			(await put("nobody", { character: { palette: "rose" } })).status,
		).toBe(403);
		expect(
			(await put("member", { character: { palette: "rose" } })).status,
		).toBe(403);
		const big = await put("owner", {
			character: { palette: "rose" },
			pad: "x".repeat(5000),
		});
		expect(big.status).toBe(413);
		expect(
			(
				await rest(app, "agents/nobody/character", {
					method: "PUT",
					body: JSON.stringify({ character: { palette: "rose" } }),
				})
			).status,
		).toBe(404);
		const still = (await (await rest(app, "agents/guide")).json()) as {
			character: { palette?: string };
		};
		expect(still.character.palette).toBe("teal");
		tab.close();
	});

	test("a turn that calls a tool is working, then thinking, and ends done", async () => {
		app.scripts.set("use-a-tool", async (request) => {
			request.progress?.({ type: "tool_start", id: "u1", tool: "bash" });
			await Bun.sleep(30);
			request.progress?.({
				type: "tool_end",
				id: "u1",
				tool: "bash",
				ok: true,
			});
			await Bun.sleep(30);
			return { ok: true, text: "used it" };
		});
		const tab = await open();
		tab.send({ type: "send", id: "w1", room: SCOUT, text: "use-a-tool" });
		const first = await tab.take(activity(SCOUT, { typing: true }));
		expect(first).toMatchObject({ phase: "thinking" });
		await tab.take(activity(SCOUT, { typing: true, phase: "working" }));
		await tab.take(activity(SCOUT, { typing: true, phase: "thinking" }));
		const last = await tab.take(activity(SCOUT, { typing: false }));
		expect(last).toMatchObject({ outcome: "done" });
		expect(last).not.toHaveProperty("phase");
		tab.close();
	});

	test("a turn that throws ends failed", async () => {
		app.scripts.set("fall-over", async () => {
			throw new Error("the model fell over");
		});
		const tab = await open();
		tab.send({ type: "send", id: "f1", room: SCOUT, text: "fall-over" });
		const last = await tab.take(activity(SCOUT, { typing: false }));
		expect(last).toMatchObject({ outcome: "failed" });
		const rows = await messagesOf(app, SCOUT);
		expect(rows.at(-1)?.text).toContain("did not go through");
		tab.close();
	});

	test("presence follows an agent working in a Discord channel", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		app.scripts.set("discord-work", async () => {
			await held;
			return { ok: true, text: "done over there" };
		});
		const tab = await open();
		const table = (frame: ServerFrame) =>
			frame.type === "presence" ? frame.agents : undefined;
		const first = await tab.take(ofType("presence"));
		expect(first.agents.guide?.busy).toBe(false);
		const handled = app.host.conversations.handle({
			channel: `discord:${ENTRY_CHANNEL}`,
			messageId: "d1",
			actor: ADA,
			authorId: ADA_DISCORD,
			authorName: "Ada",
			authorIsBot: false,
			space: GUILD,
			isDirect: false,
			mentionsBot: true,
			repliesToBot: false,
			text: "discord-work",
			attachments: [],
		});
		await tab.take((frame) => table(frame)?.guide?.busy === true, 6000);
		release();
		await handled;
		await tab.take((frame) => table(frame)?.guide?.busy === false, 6000);
		tab.close();
	});
});
