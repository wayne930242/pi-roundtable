import { expect, test } from "bun:test";
import type { InboundMessage } from "pi-roundtable";
import { describeDb } from "pi-roundtable/testing";
import type { ServerFrame } from "../api-types.ts";
import {
	app,
	Client,
	FACTS,
	hostAppSuite,
	ofType,
	post,
	ROOM_A,
	ROOM_A_ID,
	ROOM_B,
	rest,
	web,
} from "../testing/host-app-host.ts";
import type { HostActionResult, HostRoomView } from "./views.ts";

describeDb("the host rooms over a real host: actions and notes", () => {
	hostAppSuite();

	test("a button is pressed only if the card offers it to that viewer, its form is checked first, and the host's answer comes back", async () => {
		const card = await web.rooms.card(ROOM_A, {
			title: "Act",
			body: "b",
			buttons: [
				{ id: "reply", label: "Reply" },
				{
					id: "escalate",
					label: "Escalate",
					form: {
						title: "Escalate",
						submit: "Go",
						fields: [
							{
								name: "who",
								label: "Who",
								type: "select",
								required: true,
								options: [{ value: "ada", label: "Ada" }],
							},
							{ name: "why", label: "Why", type: "text", max: 5 },
						],
					},
				},
			],
		});
		app.state.acts.length = 0;
		// Mel is offered "reply" only.
		const refused = await post(
			app,
			`host/inbox/${ROOM_A_ID}/act`,
			{ action: "escalate", card: card.id },
			"mel",
		);
		expect(refused.status).toBe(403);
		// Kim reads but may not act.
		expect(
			(
				await post(
					app,
					`host/inbox/${ROOM_A_ID}/act`,
					{ action: "reply", card: card.id },
					"kim",
				)
			).status,
		).toBe(403);
		expect(
			(
				await post(
					app,
					`host/inbox/${ROOM_A_ID}/act`,
					{ action: "reply", card: "no-such-card" },
					"mel",
				)
			).status,
		).toBe(404);
		expect(app.state.acts).toEqual([]);
		const ok = (await (
			await post(
				app,
				`host/inbox/${ROOM_A_ID}/act`,
				{ action: "reply", card: card.id },
				"mel",
			)
		).json()) as HostActionResult;
		expect(ok).toEqual({
			ok: true,
			notice: "Done",
			open: { room: ROOM_B, message: 7 },
		});
		expect(app.state.acts).toEqual([
			{ who: "mel", id: ROOM_A_ID, action: "reply", card: card.id, input: {} },
		]);
		// A form: a missing required field and a value outside the options never reach the host.
		const missing = (await (
			await post(
				app,
				`host/inbox/${ROOM_A_ID}/act`,
				{ action: "escalate", card: card.id, input: {} },
				"ada",
			)
		).json()) as HostActionResult;
		expect(missing).toMatchObject({ ok: false, field: "who" });
		const outside = (await (
			await post(
				app,
				`host/inbox/${ROOM_A_ID}/act`,
				{ action: "escalate", card: card.id, input: { who: "zed" } },
				"ada",
			)
		).json()) as HostActionResult;
		expect(outside).toMatchObject({ ok: false, field: "who" });
		const long = (await (
			await post(
				app,
				`host/inbox/${ROOM_A_ID}/act`,
				{
					action: "escalate",
					card: card.id,
					input: { who: "ada", why: "too long a reason" },
				},
				"ada",
			)
		).json()) as HostActionResult;
		expect(long).toMatchObject({ ok: false, field: "why" });
		expect(app.state.acts).toHaveLength(1);
		const done = (await (
			await post(
				app,
				`host/inbox/${ROOM_A_ID}/act`,
				{ action: "escalate", card: card.id, input: { who: "ada", why: "ok" } },
				"ada",
			)
		).json()) as HostActionResult;
		expect(done.ok).toBe(true);
		expect(app.state.acts.at(-1)).toMatchObject({
			action: "escalate",
			input: { who: "ada", why: "ok" },
		});
		// A header action runs without a card; one the header does not list does not run.
		expect(
			(
				await post(
					app,
					`host/inbox/${ROOM_A_ID}/act`,
					{ action: "assign", input: { owner: "mel" } },
					"ada",
				)
			).status,
		).toBe(200);
		expect(
			(
				await post(
					app,
					`host/inbox/${ROOM_A_ID}/act`,
					{ action: "delete-everything" },
					"ada",
				)
			).status,
		).toBe(403);
		// The same press over the socket answers by refusing only when it is not taken.
		const socket = await Client.open(app, "ada");
		socket.send({
			type: "act",
			id: "act-1",
			room: ROOM_A,
			action: "delete-everything",
		});
		expect(await socket.take(ofType("refused"))).toMatchObject({
			id: "act-1",
			code: "forbidden",
		});
		socket.close();
	});

	test("a note is stored and shown and reaches no claim; a turn also reaches the claim with who sent it, as facts the router never lowers a tier from", async () => {
		const mel = await Client.open(app, "mel");
		const kim = await Client.open(app, "kim");
		for (const client of [mel, kim])
			client.send({ type: "subscribe", room: ROOM_A });
		await Bun.sleep(100);
		app.state.admitted.length = 0;
		app.state.sends.length = 0;
		mel.send({
			type: "send",
			id: "n1",
			room: ROOM_A,
			text: "internal note",
			mode: "note",
		});
		const accepted = await mel.take(ofType("accepted"));
		expect(accepted.message).toMatchObject({
			room: ROOM_A,
			text: "internal note",
			authorKind: "member",
			principalId: app.principals.mel,
		});
		expect((await kim.take(ofType("host_message"))).message.text).toBe(
			"internal note",
		);
		expect(app.state.admitted).toEqual([]);
		expect(app.state.sends).toEqual([
			{ who: "mel", id: ROOM_A_ID, mode: "note", text: "internal note" },
		]);
		mel.send({
			type: "send",
			id: "t1",
			room: ROOM_A,
			text: "ask the assistant",
		});
		await mel.take(
			(frame): frame is Extract<ServerFrame, { type: "accepted" }> =>
				frame.type === "accepted",
		);
		await Bun.sleep(100);
		expect(app.state.admitted).toHaveLength(1);
		const turn = app.state.admitted[0] as InboundMessage;
		expect(turn).toMatchObject({
			channel: ROOM_A,
			text: "ask the assistant",
			speaker: { principalId: app.principals.mel, tier: "member" },
			actor: { surface: "app", partial: true, subject: FACTS.mel.subject },
		});
		// Kim may only send notes here.
		kim.send({
			type: "send",
			id: "k1",
			room: ROOM_A,
			text: "i want to ask",
			mode: "turn",
		});
		expect(await kim.take(ofType("refused"))).toMatchObject({
			id: "k1",
			code: "forbidden",
		});
		kim.send({ type: "send", id: "k2", room: ROOM_A, text: "   " });
		expect(await kim.take(ofType("refused"))).toMatchObject({
			id: "k2",
			code: "forbidden",
		});
		// The kind may refuse a message; nothing is stored then.
		app.state.refuse = "closed";
		mel.send({
			type: "send",
			id: "r1",
			room: ROOM_A,
			text: "will be refused",
			mode: "note",
		});
		expect(await mel.take(ofType("refused"))).toMatchObject({
			id: "r1",
			code: "not_accepted",
		});
		app.state.refuse = undefined;
		const stored = (await (
			await rest(app, `host/inbox/${ROOM_A_ID}`, { who: "ada" })
		).json()) as HostRoomView;
		expect(stored.messages.some((m) => m.text === "will be refused")).toBe(
			false,
		);
		mel.close();
		kim.close();
	});

	test("the server never reads a message's text for @AI: a note frame whose text starts with it stays a note and reaches no claim, and a turn is only an explicit turn", async () => {
		const mel = await Client.open(app, "mel");
		const kim = await Client.open(app, "kim");
		for (const client of [mel, kim])
			client.send({ type: "subscribe", room: ROOM_A });
		await Bun.sleep(100);
		app.state.admitted.length = 0;
		app.state.sends.length = 0;
		for (const [id, text] of [
			["m1", "@AI summarize this"],
			["m2", "forwarded: hey @AI, do it"],
		] as const) {
			mel.send({ type: "send", id, room: ROOM_A, text, mode: "note" });
			await mel.take(ofType("accepted"));
		}
		kim.send({
			type: "send",
			id: "k1",
			room: ROOM_A,
			text: "@AI are you there",
			mode: "note",
		});
		await kim.take(ofType("accepted"));
		await Bun.sleep(100);
		expect(app.state.sends).toEqual([
			{ who: "mel", id: ROOM_A_ID, mode: "note", text: "@AI summarize this" },
			{
				who: "mel",
				id: ROOM_A_ID,
				mode: "note",
				text: "forwarded: hey @AI, do it",
			},
			{ who: "kim", id: ROOM_A_ID, mode: "note", text: "@AI are you there" },
		]);
		expect(app.state.admitted).toEqual([]);
		// A turn is the explicit mode, with or without the token in its text.
		mel.send({
			type: "send",
			id: "t1",
			room: ROOM_A,
			text: "no token here",
			mode: "turn",
		});
		await mel.take(ofType("accepted"));
		await Bun.sleep(100);
		expect(app.state.admitted).toHaveLength(1);
		mel.close();
		kim.close();
	});
});
