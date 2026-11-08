import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
	type ApprovedBy,
	IDENTITY,
	MODES,
	type PromptWait,
	promptScope,
} from "pi-roundtable";
import { describeDb } from "pi-roundtable/testing";
import type { MessagesView, ServerFrame } from "../api-types.ts";
import {
	ADA_DISCORD,
	agentReply,
	type Booted,
	boot,
	Client,
	GUIDE,
	MEL,
	ofType,
	rest,
	SCOUT,
} from "../testing/app-host.ts";

describeDb("the owner app over a real host", () => {
	let app: Booted;

	beforeAll(async () => {
		app = await boot({ auth: "verifier", graceSeconds: 0.4 });
		await app.host.context.services.get(IDENTITY).resolve(MEL);
	}, 30_000);

	afterAll(async () => {
		await app.stop();
	});

	afterEach(() => app.reset());

	test("a card reaches every owner socket and an approval runs the call", async () => {
		const outcomes: unknown[] = [];
		app.scripts.set("hold-me", async (request, signal) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			let by: ApprovedBy | undefined;
			let prompt: string | undefined;
			const result = await prompts?.confirm(
				"Send it?",
				"Send the note",
				signal,
				"owner",
				undefined,
				{ action: "send a note", tool: "note_send", input: { to: "team" } },
				{
					approvedBy: (who) => {
						by = who;
					},
					approvedPrompt: (id) => {
						prompt = id;
					},
				},
			);
			outcomes.push({ result, by, prompt });
			return { ok: true, text: `held ${result}` };
		});
		const one = await Client.open(app, { "x-actor": "owner" });
		const two = await Client.open(app, { "x-actor": "owner" });
		if (!one || !two) throw new Error("the owner was refused");
		one.send({ type: "send", id: "h1", room: SCOUT, text: "hold-me" });
		const shown = await one.take(ofType("prompt"));
		const same = await two.take(ofType("prompt"));
		expect(same.prompt.id).toBe(shown.prompt.id);
		expect(shown).toMatchObject({
			room: SCOUT,
			prompt: {
				kind: "approval",
				title: "Send it?",
				purpose: "action",
				approval: { tool: "note_send" },
			},
		});
		// The second socket answers; both are told it closed.
		two.send({ type: "approval", prompt: shown.prompt.id, approved: true });
		expect(await one.take(ofType("prompt_closed"))).toMatchObject({
			prompt: shown.prompt.id,
			outcome: "approved",
		});
		await two.take(ofType("prompt_closed"));
		await one.take(agentReply("scout"));
		expect(outcomes).toEqual([
			{
				result: "approved",
				by: {
					principalId: ADA_DISCORD,
					speakerId: `discord:${ADA_DISCORD}`,
					name: "Ada",
					owner: true,
				},
				prompt: shown.prompt.id,
			},
		]);
		// A socket that connects later is shown the cards still open.
		one.close();
		two.close();
	});

	test("cancelling a question tells the tool it was declined", async () => {
		const answers: unknown[] = [];
		app.scripts.set("ask-me", async (request, signal) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			const answer = await prompts?.ask(
				"Which?",
				{
					question: "Which colour?",
					options: [{ label: "red" }, { label: "blue" }],
					multi: false,
					allowOther: false,
				},
				signal,
			);
			answers.push(answer);
			return { ok: true, text: "asked" };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "a1", room: SCOUT, text: "ask-me" });
		const card = await tab.take(ofType("prompt"));
		expect(card.prompt.kind).toBe("ask");
		// An answer the question does not allow is refused and the card stays open.
		tab.send({
			type: "answer",
			prompt: card.prompt.id,
			answer: { choices: ["green"] },
		});
		expect((await tab.take(ofType("refused"))).code).toBe("bad_frame");
		tab.send({ type: "cancel", prompt: card.prompt.id });
		expect(await tab.take(ofType("prompt_closed"))).toMatchObject({
			outcome: "declined",
		});
		await tab.take(agentReply("scout"));
		expect(answers).toEqual(["declined"]);
		tab.close();
	});

	test("answered cards stay in the room's history after a reload, with who answered and what", async () => {
		const seenAnswers: unknown[] = [];
		app.scripts.set("keep-cards", async (request, signal) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			const approved = await prompts?.confirm(
				"Keep it?",
				"Keep the card",
				signal,
				"owner",
				undefined,
				{ action: "keep", tool: "note_send", input: { to: "team" } },
			);
			const answer = await prompts?.ask(
				"Which?",
				{
					question: "Which colour?",
					options: [{ label: "red" }, { label: "blue" }],
					multi: false,
					allowOther: true,
				},
				signal,
			);
			seenAnswers.push(approved, answer);
			return { ok: true, text: "cards kept" };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "k1", room: SCOUT, text: "keep-cards" });
		const approval = await tab.take(ofType("prompt"));
		tab.send({
			type: "approval",
			prompt: approval.prompt.id,
			approved: true,
		});
		const approvalClosed = await tab.take(ofType("prompt_closed"));
		// The closing frame says who and when, as a page that was not watching will read it.
		expect(approvalClosed).toMatchObject({
			outcome: "approved",
			by: "Ada",
		});
		expect(Date.parse(approvalClosed.closedAt ?? "")).toBeGreaterThan(0);
		const question = await tab.take(ofType("prompt"));
		tab.send({
			type: "answer",
			prompt: question.prompt.id,
			answer: { choices: ["red"], text: "a dark one" },
		});
		await tab.take(ofType("prompt_closed"));
		await tab.take(agentReply("scout"));
		tab.close();

		// A new socket is shown nothing open, but the history holds both cards.
		const fresh = await Client.open(app, { "x-actor": "owner" });
		if (!fresh) throw new Error("the owner was refused");
		await fresh.take(ofType("ready"));
		expect(await fresh.sees(ofType("prompt"))).toBe(false);
		fresh.close();
		const page = (await (
			await rest(app, `rooms/${encodeURIComponent(SCOUT)}/messages`)
		).json()) as MessagesView;
		const mine = page.cards.filter((card) =>
			[approval.prompt.id, question.prompt.id].includes(card.frame.id),
		);
		expect(mine.map((card) => card.frame.id)).toEqual([
			approval.prompt.id,
			question.prompt.id,
		]);
		expect(mine[0]).toMatchObject({
			room: SCOUT,
			outcome: "approved",
			by: "Ada",
			frame: {
				kind: "approval",
				title: "Keep it?",
				approval: { tool: "note_send" },
			},
		});
		expect(mine[1]).toMatchObject({
			outcome: "answered",
			by: "Ada",
			answer: { kind: "ask", answer: { choices: ["red"], text: "a dark one" } },
			frame: { kind: "ask", question: "Which colour?" },
		});
		expect(Date.parse(mine[1]?.closedAt ?? "")).toBeGreaterThanOrEqual(
			Date.parse(mine[1]?.frame.at ?? ""),
		);
		// They stand where they opened: after the owner's message, before the agent's reply.
		// The database is shared by runs, so the newest of each is this run's.
		const owner = page.messages.findLast((m) => m.text === "keep-cards");
		const reply = page.messages.findLast((m) => m.text === "cards kept");
		expect(Date.parse(mine[0]?.frame.at ?? "")).toBeGreaterThanOrEqual(
			Date.parse(owner?.at ?? ""),
		);
		expect(Date.parse(mine[1]?.frame.at ?? "")).toBeLessThanOrEqual(
			Date.parse(reply?.at ?? ""),
		);
		// Another room's history holds neither.
		const guide = (await (
			await rest(app, `rooms/${encodeURIComponent(GUIDE)}/messages`)
		).json()) as MessagesView;
		expect(guide.cards.map((card) => card.frame.id)).not.toContain(
			approval.prompt.id,
		);
		// The history is the owner's; a member reads none of it.
		expect(
			(
				await rest(app, `rooms/${encodeURIComponent(SCOUT)}/messages`, {
					who: "member",
				})
			).status,
		).toBe(403);
		expect(seenAnswers).toEqual([
			"approved",
			{ choices: ["red"], text: "a dark one" },
		]);
	});

	test("a page of history holds the cards from its first message on, and the older page the rest", async () => {
		app.scripts.set("page-cards", async (request, signal) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			await prompts?.confirm("Page it?", "Page the card", signal);
			return { ok: true, text: "page done" };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		tab.send({ type: "send", id: "pg1", room: GUIDE, text: "page-cards" });
		const card = await tab.take(ofType("prompt"));
		tab.send({ type: "approval", prompt: card.prompt.id, approved: false });
		await tab.take(ofType("prompt_closed"));
		await tab.take(agentReply("guide"));
		tab.close();
		const get = async (query: string) =>
			(await (
				await rest(app, `rooms/${encodeURIComponent(GUIDE)}/messages?${query}`)
			).json()) as MessagesView;
		const all = await get("limit=100");
		const reply = all.messages.at(-1);
		expect(reply?.text).toBe("page done");
		const start = all.messages.findLast((m) => m.text === "page-cards");
		// The latest page of one message: the agent's reply, after the card.
		const latest = await get("limit=1");
		expect(latest.more).toBe(true);
		expect(latest.cards.map((c) => c.frame.id)).not.toContain(card.prompt.id);
		// The page before the reply, which reaches back to the owner's message, holds the card.
		const older = await get(`limit=100&before=${reply?.id}`);
		// The host keeps every earlier run's messages, so this page may have older ones; it reaches back to the owner's own.
		expect(older.messages.some((m) => m.id === start?.id)).toBe(true);
		const found = older.cards.find((c) => c.frame.id === card.prompt.id);
		expect(found).toMatchObject({ outcome: "declined", by: "Ada" });
		// Page by page, every card is on exactly one page.
		const once: string[] = [];
		let before: number | undefined;
		for (;;) {
			const page = await get(`limit=1${before ? `&before=${before}` : ""}`);
			once.push(...page.cards.map((c) => c.frame.id));
			before = page.messages[0]?.id;
			// Down to this run's own first message; the database holds the earlier runs' too.
			if (!page.more || (before ?? 0) <= (start?.id ?? 0)) break;
		}
		expect(once.filter((id) => id === card.prompt.id)).toHaveLength(1);
		expect(new Set(once).size).toBe(once.length);
	});

	test("after the grace the card stays open and a late approval starts a turn in the room", async () => {
		const waits: unknown[] = [];
		const results: unknown[] = [];
		app.scripts.set("late-card", async (request, signal) => {
			const prompts = app.host.context.surfaces.prompts(
				request.channel,
				promptScope(request.speaker),
			);
			const wait: PromptWait = {
				late: (answer) => {
					waits.push(answer);
					return "carry on with the approved plan";
				},
			};
			const result = await prompts?.confirm(
				"Deploy?",
				"Deploy now",
				signal,
				"owner",
				wait,
				undefined,
				{ purpose: "action" },
			);
			results.push(result);
			return { ok: true, text: `late ${result}` };
		});
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		// A socket that sends before it is ready may be shown the open card twice.
		await tab.take(ofType("ready"));
		tab.send({ type: "send", id: "l1", room: GUIDE, text: "late-card" });
		const card = await tab.take(ofType("prompt"));
		expect(card.prompt).not.toHaveProperty("late");
		// The turn stops waiting and the card is shown again as late.
		const again = await tab.take(ofType("prompt"));
		expect(again.prompt).toMatchObject({ id: card.prompt.id, late: true });
		await tab.take(agentReply("guide"));
		expect(results).toEqual(["pending"]);
		// A fresh socket is shown the open card too.
		const fresh = await Client.open(app, { "x-actor": "owner" });
		if (!fresh) throw new Error("the owner was refused");
		const resent = await fresh.take(ofType("prompt"));
		expect(resent.prompt).toMatchObject({ id: card.prompt.id, late: true });
		fresh.close();
		tab.send({ type: "approval", prompt: card.prompt.id, approved: true });
		await tab.take(ofType("prompt_closed"));
		expect(waits).toMatchObject([
			{ kind: "approval", approved: true, by: "Ada" },
		]);
		// The text `late` returned is the owner's message, in the room, and runs a turn.
		const message = await tab.take(
			(frame): frame is Extract<ServerFrame, { type: "message" }> =>
				frame.type === "message" && frame.message.kind === "owner",
		);
		expect(message.message.text).toBe("carry on with the approved plan");
		await tab.take(
			(frame) =>
				frame.type === "message" &&
				frame.message.text === "echo carry on with the approved plan",
		);
		tab.close();
	});

	test("yolo approvals are shown in the room", async () => {
		const tab = await Client.open(app, { "x-actor": "owner" });
		if (!tab) throw new Error("the owner was refused");
		const modes = app.host.context.services.get(MODES);
		modes.autoApproved({
			channel: SCOUT,
			tool: "shell",
			action: "write notes.txt",
			classes: ["shell.write"],
			principalId: ADA_DISCORD,
			at: new Date(),
		});
		const line = await tab.take(
			(frame) => frame.type === "message" && frame.message.kind === "system",
		);
		if (line.type !== "message") throw new Error("expected a message");
		expect(line.message.text).toContain("write notes.txt");
		expect(await tab.take(ofType("auto_approved"))).toEqual({
			type: "auto_approved",
			room: SCOUT,
			tool: "shell",
			action: "write notes.txt",
		});
		tab.close();
	});

	test("progress streams to the sockets that focus the room", async () => {
		app.scripts.set("show-progress", async (request) => {
			request.progress?.({ type: "text", delta: "thinking about it" });
			request.progress?.({ type: "tool_start", id: "t1", tool: "web_search" });
			return { ok: true, text: "done" };
		});
		const watching = await Client.open(app, { "x-actor": "owner" });
		const elsewhere = await Client.open(app, { "x-actor": "owner" });
		if (!watching || !elsewhere) throw new Error("the owner was refused");
		watching.send({ type: "hello", visible: true, focus: SCOUT });
		elsewhere.send({ type: "hello", visible: true, focus: GUIDE });
		await Bun.sleep(100);
		watching.send({
			type: "send",
			id: "p1",
			room: SCOUT,
			text: "show-progress",
		});
		expect(await watching.take(ofType("progress"))).toEqual({
			type: "progress",
			room: SCOUT,
			event: { type: "text", delta: "thinking about it" },
		});
		await watching.take(agentReply("scout"));
		await elsewhere.take(agentReply("scout"));
		expect(elsewhere.frames.some((f) => f.type === "progress")).toBe(false);
		watching.close();
		elsewhere.close();
	});
});
