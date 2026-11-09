import { expect, test } from "bun:test";
import { type ChannelKey, promptScope } from "pi-roundtable";
import { describeDb } from "pi-roundtable/testing";
import {
	AGENT_ROOM,
	app,
	Client,
	external,
	hostAppSuite,
	ofType,
	PNG,
	post,
	ROOM_A,
	ROOM_A_ID,
	rest,
	web,
} from "../testing/host-app-host.ts";
import type { HostActionResult, HostPageView } from "./views.ts";

describeDb("the host rooms over a real host: access and answering", () => {
	hostAppSuite();

	test("cutting off a reader: after accessChanged the next frame is not delivered, and the room is gone for them", async () => {
		const kim = await Client.open(app, "kim");
		kim.send({ type: "subscribe", room: ROOM_A });
		await Bun.sleep(100);
		await web.rooms.post(ROOM_A, external("before the cut"));
		expect((await kim.take(ofType("host_message"))).message.text).toBe(
			"before the cut",
		);
		app.state.grants.get(app.principals.kim)?.delete(ROOM_A_ID);
		web.rooms.accessChanged(app.principals.kim);
		// Their page is told to look again, which finds the room gone.
		expect(await kim.take(ofType("room_changed"))).toMatchObject({
			room: ROOM_A,
		});
		kim.skip();
		await web.rooms.post(ROOM_A, external("after the cut"));
		expect(await kim.sees(ofType("host_message"), 300)).toBe(false);
		expect(
			(await rest(app, `host/inbox/${ROOM_A_ID}`, { who: "kim" })).status,
		).toBe(404);
		app.state.grants
			.get(app.principals.kim)
			?.set(ROOM_A_ID, { read: true, send: ["note"], act: false });
		web.rooms.accessChanged(app.principals.kim);
		kim.close();
	});

	test("a room's header or list is refreshed when the host says it changed, to those who still read it", async () => {
		const mel = await Client.open(app, "mel");
		mel.send({ type: "subscribe", room: ROOM_A });
		// Mel's list was asked, so the list's changes are told to them.
		await rest(app, "host/inbox", { who: "mel" });
		await Bun.sleep(100);
		mel.skip();
		web.rooms.changed(ROOM_A);
		expect((await mel.take(ofType("room_changed"))).room).toBe(ROOM_A);
		expect(mel.frames.find(ofType("list_changed"))?.kind).toBe("inbox");
		// A person whose list is undefined is not told of it.
		const zed = await Client.open(app, "zed");
		await rest(app, "host/inbox", { who: "zed" });
		zed.skip();
		web.rooms.changed(ROOM_A);
		expect(await zed.sees(ofType("list_changed"), 300)).toBe(false);
		mel.close();
		zed.close();
	});

	test("a link to a room, or to one of its messages, is the same-origin address the page routes", async () => {
		expect(web.rooms.link(ROOM_A)).toBe(
			`/console/#/room/${encodeURIComponent(ROOM_A)}`,
		);
		expect(web.rooms.link(ROOM_A, 42)).toBe(
			`/console/#/room/${encodeURIComponent(ROOM_A)}?message=42`,
		);
		expect(() => web.rooms.link("app:nothing.abcdefgh" as ChannelKey)).toThrow(
			"registered kind",
		);
	});

	test("pages: the listed ones, the view with its query, the action, and a refresh to those the page is visible to", async () => {
		const ada = (await (await rest(app, "config", { who: "ada" })).json()) as {
			pages?: { id: string; icon?: string }[];
		};
		expect(ada.pages?.map((page) => page.id)).toEqual(["mailboxes"]);
		// The icon the page named reaches the shell, which draws it in the navigation.
		expect(ada.pages?.[0]?.icon).toBe("megaphone");
		const view = (await (
			await rest(app, "pages/mailboxes?q=hello", { who: "ada" })
		).json()) as HostPageView;
		expect(view.title).toBe("Mailboxes");
		expect(view.sections[0]).toEqual({
			kind: "markdown",
			text: "filter: hello",
		});
		expect((await rest(app, "pages/mailboxes", { who: "mel" })).status).toBe(
			404,
		);
		expect((await rest(app, "pages/nothing", { who: "ada" })).status).toBe(404);
		const result = (await (
			await post(
				app,
				"pages/mailboxes/act",
				{ action: "connect", input: { address: "a@b.test" } },
				"ada",
			)
		).json()) as HostActionResult;
		expect(result).toEqual({ ok: true, notice: "Connected" });
		expect(app.state.pageActs.at(-1)).toEqual({
			who: "ada",
			action: "connect",
			input: { address: "a@b.test" },
		});
		expect(
			(
				await post(
					app,
					"pages/mailboxes/act",
					{ action: "connect", input: {} },
					"mel",
				)
			).status,
		).toBe(404);
		const adaSocket = await Client.open(app, "ada");
		const melSocket = await Client.open(app, "mel");
		await Bun.sleep(50);
		web.pages.changed("mailboxes");
		expect(await adaSocket.take(ofType("page_changed"))).toEqual({
			type: "page_changed",
			page: "mailboxes",
		});
		expect(await melSocket.sees(ofType("page_changed"), 400)).toBe(false);
		adaSocket.close();
		melSocket.close();
	});

	test("a page's picture is a saved PNG, JPEG or WebP, shown only to those the page is visible to", async () => {
		const id = await web.pages.saveAsset("mailboxes", {
			name: "chart.png",
			type: "image/png",
			bytes: PNG,
		});
		const seen = await rest(app, `files/${id}`, { who: "ada" });
		expect(seen.status).toBe(200);
		expect(seen.headers.get("content-type")).toBe("image/png");
		// The page is the owners'; a member is not shown what hangs on it.
		expect((await rest(app, `files/${id}`, { who: "mel" })).status).toBe(404);
		// Only an image the bytes prove: GIF, a text and a type that lies are refused.
		const gif = Uint8Array.from([
			0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0,
		]);
		for (const bytes of [
			gif,
			new TextEncoder().encode("<svg onload=alert(1)>"),
		])
			await expect(
				web.pages.saveAsset("mailboxes", {
					name: "x.png",
					type: "image/png",
					bytes,
				}),
			).rejects.toThrow(/PNG, JPEG or WebP/);
		await expect(
			web.pages.saveAsset("no-such-page", {
				name: "x.png",
				type: "image/png",
				bytes: PNG,
			}),
		).rejects.toThrow(/no page/);
	});

	test("a press on a card that is not one of the room's, or a room that is not a host's, is not taken over the socket either", async () => {
		const ada = await Client.open(app, "ada");
		ada.send({
			type: "act",
			id: "x1",
			room: AGENT_ROOM,
			action: "assign",
		});
		expect(await ada.take(ofType("refused"))).toMatchObject({
			id: "x1",
			code: "unknown_room",
		});
		ada.send({ type: "act", id: "x2", page: "nothing", action: "go" });
		expect(await ada.take(ofType("refused"))).toMatchObject({ id: "x2" });
		ada.send({ type: "subscribe", room: AGENT_ROOM });
		expect(await ada.take(ofType("refused"))).toMatchObject({
			code: "unknown_room",
		});
		ada.close();
	});

	test("answering a card in a room whose access reads roles keeps the reader in the room", async () => {
		const mel = await Client.open(app, "mel");
		mel.send({ type: "subscribe", room: ROOM_A });
		await Bun.sleep(100);
		let reply: unknown;
		app.state.script = async (message, speaker) => {
			if (!speaker) return;
			const prompts = app.host.context.surfaces.prompts(
				message.channel,
				promptScope(speaker, "shared"),
			);
			reply = await prompts?.ask("Which one?", {
				question: "Which mailbox?",
				options: [{ label: "support" }, { label: "sales" }],
				multi: false,
				allowOther: false,
			});
		};
		mel.send({ type: "send", id: "roles1", room: ROOM_A, text: "which" });
		const question = await mel.take(ofType("prompt"));
		// With no followed room nothing refreshes the memo, so the answer asks the kind afresh.
		mel.send({ type: "unsubscribe", room: ROOM_A });
		app.state.needRole = "web:role:pm";
		try {
			await Bun.sleep(11_000);
			mel.send({
				type: "answer",
				prompt: question.prompt.id,
				answer: { choices: ["support"] },
			});
			await Bun.sleep(300);
			expect(await mel.sees(ofType("refused"), 100)).toBe(false);
			expect(reply).toBeDefined();
		} finally {
			app.state.needRole = undefined;
		}
	}, 30_000);

	test("a question or an approval in a host room is its speaker's, the named approvers' and the owners' to answer, and a reader sees it only by following the room", async () => {
		const mel = await Client.open(app, "mel");
		const ada = await Client.open(app, "ada");
		for (const client of [mel, ada])
			client.send({ type: "subscribe", room: ROOM_A });
		await Bun.sleep(100);
		let decision: string | undefined;
		let reply: unknown;
		app.state.script = async (message, speaker) => {
			if (!speaker) return;
			const prompts = app.host.context.surfaces.prompts(
				message.channel,
				promptScope(speaker, "shared"),
			);
			if (message.text.startsWith("approve")) {
				// Mel asks; Ada (an owner) alone is named, at the member tier.
				const approval = await prompts?.confirm(
					"Send it?",
					"Send the draft to the customer",
					undefined,
					"member",
					undefined,
					undefined,
					{ approvers: [app.principals.ada] },
				);
				decision = approval ?? "none";
			} else {
				reply = await prompts?.ask("Which one?", {
					question: "Which mailbox?",
					options: [{ label: "support" }, { label: "sales" }],
					multi: false,
					allowOther: false,
				});
			}
		};
		mel.send({
			type: "send",
			id: "ask1",
			room: ROOM_A,
			text: "approve this draft",
		});
		const card = await mel.take(ofType("prompt"));
		expect(card.room).toBe(ROOM_A);
		// A reader who follows the room later still gets the open card; one who cannot read it gets nothing.
		const kim = await Client.open(app, "kim");
		const zed = await Client.open(app, "zed");
		expect(await kim.sees(ofType("prompt"), 200)).toBe(false);
		kim.send({ type: "subscribe", room: ROOM_A });
		expect((await kim.take(ofType("prompt"))).prompt.id).toBe(card.prompt.id);
		zed.send({ type: "subscribe", room: ROOM_A });
		expect(await zed.sees(ofType("prompt"), 300)).toBe(false);
		// Neither Kim (a reader) nor Mel (the speaker, not named) may approve or decline it.
		kim.send({ type: "approval", prompt: card.prompt.id, approved: true });
		expect(await kim.take(ofType("refused"))).toMatchObject({
			prompt: card.prompt.id,
		});
		mel.send({ type: "approval", prompt: card.prompt.id, approved: true });
		expect(await mel.take(ofType("refused"))).toMatchObject({
			prompt: card.prompt.id,
		});
		mel.send({ type: "approval", prompt: card.prompt.id, approved: false });
		expect(await mel.take(ofType("refused"))).toMatchObject({
			prompt: card.prompt.id,
		});
		expect(decision).toBeUndefined();
		ada.send({ type: "approval", prompt: card.prompt.id, approved: true });
		await ada.take((frame) => frame.type === "prompt_closed");
		await Bun.sleep(50);
		expect(decision).toBe("approved");
		// A question is its speaker's: Mel answers it; Kim cannot.
		mel.skip();
		kim.skip();
		mel.send({ type: "send", id: "ask2", room: ROOM_A, text: "which mailbox" });
		const question = await mel.take(ofType("prompt"));
		kim.send({
			type: "answer",
			prompt: question.prompt.id,
			answer: { choices: ["sales"] },
		});
		expect(await kim.take(ofType("refused"))).toMatchObject({
			prompt: question.prompt.id,
		});
		mel.send({
			type: "answer",
			prompt: question.prompt.id,
			answer: { choices: ["support"] },
		});
		await mel.take((frame) => frame.type === "prompt_closed");
		await Bun.sleep(50);
		expect(reply).toBeDefined();
		app.state.script = undefined;
		for (const client of [mel, ada, kim, zed]) client.close();
	});
});
