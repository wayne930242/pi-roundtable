import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type {
	BlockAnswerBody,
	BlockFields,
	RoomMessage,
	ServerFrame,
} from "../src/api-types.ts";
import {
	agentReply,
	CHECKLIST,
	FORM,
	HIDDEN_FORM,
	MULTI_FORM,
	OPTIONS,
	REVIEW,
	SUGGEST,
	WORDY_SUGGEST,
} from "./block-answers.fixtures.ts";
import { LiveRow, MessageRow, PendingRow } from "./components/message-row.tsx";
import { RoomLog } from "./components/room-log.tsx";
import type { TestPage } from "./dom.ts";
import { store } from "./lib/app-store.ts";
import { type BlockReply, resetBlockCells } from "./lib/block-answers.ts";
import { ConfigContext } from "./lib/config.ts";
import { frameListeners } from "./lib/frame-taps.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";

const settle = (ms = 40) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The tests of answering a block on the page, run inside the DOM the caller's file opened (the `pbs-*` elements are defined in the first DOM that loads them, so they cannot be split across files). */
export function blockAnswerCases(getPage: () => TestPage): void {
	let page: TestPage;
	let calls: {
		room: string;
		message: number;
		block: number;
		answer: BlockAnswerBody;
	}[] = [];
	/** What the server says to the next answer; a promise lets a test hold the reply back. */
	let nextReply: () => Promise<BlockReply> = async () => ({ ok: true });

	beforeAll(async () => {
		page = getPage();
		setConnection(
			partial<AppConnection>({
				open: true,
				focus: () => undefined,
				// The server's word on a block_answer comes back as the frame it would send.
				send: (frame) => {
					if (frame.type !== "block_answer") return true;
					calls.push({
						room: frame.room,
						message: frame.message,
						block: frame.block,
						answer: frame.answer,
					});
					nextReply().then((reply) => {
						const back: ServerFrame = reply.ok
							? {
									type: "accepted",
									id: frame.id,
									room: frame.room,
									message: { id: 1 } as never,
								}
							: {
									type: "block_refused",
									id: frame.id,
									room: frame.room,
									message: frame.message,
									block: frame.block,
									code: reply.code,
									...(reply.fields ? { fields: reply.fields } : {}),
								};
						for (const listen of [...frameListeners]) listen(back);
					});
					return true;
				},
			}),
		);
		await import("./components/blocks.tsx");
	});
	afterAll(() => {
		setConnection(undefined);
	});
	afterEach(() => {
		calls = [];
		nextReply = async () => ({ ok: true });
		resetBlockCells();
	});

	let ids = 100;
	const reply = (text: string, over: Partial<RoomMessage> = {}) =>
		agentReply(ids++, text, over);

	const row = (message: RoomMessage, answerable = true) => (
		<MessageRow
			message={message}
			character={undefined}
			header
			enter={false}
			timeZone="UTC"
			quotable
			answerable={answerable}
		/>
	);

	let renders = 0;
	/** Draws `node` in a list of its own, so no block keeps the state of an earlier test; `again` redraws the list that is there. */
	async function draw(
		node: React.ReactNode,
		again = false,
	): Promise<HTMLElement> {
		if (!again) renders++;
		await page.render(<ol key={renders}>{node}</ol>);
		await page.act(() => settle());
		return page.container;
	}

	const shadow = (root: HTMLElement, tag: string): ShadowRoot => {
		const element = root.querySelector(tag) as HTMLElement | null;
		if (!element?.shadowRoot) throw new Error(`no ${tag}`);
		return element.shadowRoot;
	};
	const slot = (root: HTMLElement) =>
		root.querySelector(".block-answer") as HTMLElement;
	const noteOf = (root: HTMLElement) =>
		root.querySelector(".block-note")?.textContent;
	const click = (element: Element | null | undefined) =>
		page.click(element ?? null);
	const tick = async (box: HTMLInputElement) => {
		await page.act(() => {
			box.checked = true;
			box.dispatchEvent(new Event("change", { bubbles: true }));
		});
	};

	test("a pick sends nothing until the server has it, shows Sending…, locks the block with what went, and takes no second tap", async () => {
		const gate = Promise.withResolvers<BlockReply>();
		nextReply = () => gate.promise;
		const root = await draw(row(reply(`Which?\n\n${OPTIONS}`)));
		expect(slot(root).dataset.state).toBe("open");
		const picks = shadow(root, "pbs-options").querySelectorAll("[part=pick]");
		await click(picks[0]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			room: "app:agent.guide",
			block: 0,
			answer: { kind: "pick", fields: [["picked", "SQLite"]] },
		});
		// On its way: inert, with the note, and no lock yet.
		expect(slot(root).dataset.state).toBe("pending");
		expect(noteOf(root)).toBe("Sending…");
		expect(slot(root).querySelector("[inert]")).not.toBeNull();
		await click(picks[1]);
		expect(calls).toHaveLength(1);
		gate.resolve({ ok: true });
		await page.act(() => settle());
		expect(slot(root).dataset.state).toBe("answered");
		const element = root.querySelector("pbs-options") as {
			answered?: BlockFields;
		};
		expect(element.answered).toEqual([["picked", "SQLite"]]);
		expect(noteOf(root)).toBeUndefined();
	});

	test("a suggestion chip sends its text and a plain form sends at once", async () => {
		const root = await draw(row(reply(`${SUGGEST}\n\n${FORM}`)));
		await click(shadow(root, "pbs-suggest").querySelector("[part=chip]"));
		expect(calls[0]?.answer).toMatchObject({
			kind: "suggest",
			fields: [["text", "Ship it"]],
		});
		const form = shadow(root, "pbs-form");
		await tick(form.querySelector("input[type=radio]") as HTMLInputElement);
		const note = form.querySelector("[part=note]") as HTMLTextAreaElement;
		note.value = " The one we run. ";
		note.dispatchEvent(new Event("input"));
		await click(form.querySelector("[part=submit]"));
		expect(calls).toHaveLength(2);
		expect(calls[1]?.answer.kind).toBe("form");
		expect(calls[1]?.answer.fields).toContainEqual(["store", "SQLite"]);
		// Other comments go out as the reserved pi-note field, trimmed.
		expect(calls[1]?.answer.fields).toContainEqual([
			"pi-note",
			"The one we run.",
		]);
		expect(root.querySelector(".block-confirm")).toBeNull();
	});

	test("a suggestion chip whose text is not its label shows the exact text first instead of sending", async () => {
		const root = await draw(row(reply(WORDY_SUGGEST)));
		const chips = shadow(root, "pbs-suggest").querySelectorAll("[part=chip]");
		await click(chips[0]);
		expect(calls).toHaveLength(0);
		expect(root.querySelector(".block-confirm-text")?.textContent).toBe(
			"Yes. I approve deleting the staging database, go ahead",
		);
		// A chip that says what it sends still goes at once.
		await click(chips[1]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.answer.fields).toEqual([["text", "Wait"]]);
	});

	test("a form with a multi question sends nothing on a pick, shows every chosen value, and sends only on Send", async () => {
		const root = await draw(row(reply(MULTI_FORM)));
		const form = shadow(root, "pbs-form");
		const boxes = [
			...form.querySelectorAll("input[type=checkbox]"),
		] as HTMLInputElement[];
		await tick(boxes[0] as HTMLInputElement);
		await tick(boxes[1] as HTMLInputElement);
		expect(calls).toHaveLength(0);
		await click(form.querySelector("[part=submit]"));
		// The step shows the exact text that goes, with both values.
		expect(calls).toHaveLength(0);
		const text = root.querySelector(".block-confirm-text")?.textContent ?? "";
		expect(text).toContain("Cache");
		expect(text).toContain("Queue");
		// Back keeps the picks and sends nothing.
		await click(
			[...root.querySelectorAll(".block-confirm button")].find(
				(b) => b.textContent === "Back",
			),
		);
		expect(root.querySelector(".block-confirm")).toBeNull();
		expect(calls).toHaveLength(0);
		await click(form.querySelector("[part=submit]"));
		await click(
			[...root.querySelectorAll(".block-confirm button")].find(
				(b) => b.textContent === "Send",
			),
		);
		expect(calls).toHaveLength(1);
		const sent =
			calls[0]?.answer.fields.map(([, value]) => value).join(" ") ?? "";
		expect(sent).toContain("Cache");
		expect(sent).toContain("Queue");
		await page.act(() => settle());
		expect(slot(root).dataset.state).toBe("answered");
	});

	test("a required multi question with nothing chosen is refused at that question and sends nothing", async () => {
		const root = await draw(row(reply(MULTI_FORM)));
		const form = shadow(root, "pbs-form");
		await click(form.querySelector("[part=submit]"));
		expect(calls).toHaveLength(0);
		expect(root.querySelector(".block-confirm")).toBeNull();
		expect(form.querySelector("[part=error]")?.textContent).toContain("extras");
	});

	test("a checklist always shows what will be sent first", async () => {
		const root = await draw(row(reply(CHECKLIST)));
		const list = shadow(root, "pbs-checklist");
		await tick(list.querySelector("input[type=checkbox]") as HTMLInputElement);
		await click(list.querySelector("[part=submit]"));
		expect(calls).toHaveLength(0);
		const text = root.querySelector(".block-confirm-text")?.textContent ?? "";
		expect(text).toContain("☑ Tests");
		expect(text).toContain("☐ Docs");
		await click(
			[...root.querySelectorAll(".block-confirm button")].find(
				(b) => b.textContent === "Send",
			),
		);
		expect(calls[0]?.answer).toMatchObject({
			kind: "checklist",
			fields: [
				["Tests", "checked"],
				["Docs", "unchecked"],
			],
		});
	});

	test("a value the owner was not shown as it goes is shown first, even in a form that takes one value", async () => {
		const root = await draw(row(reply(HIDDEN_FORM)));
		const form = shadow(root, "pbs-form");
		await tick(form.querySelector("input[type=radio]") as HTMLInputElement);
		await click(form.querySelector("[part=submit]"));
		expect(calls).toHaveLength(0);
		expect(root.querySelector(".block-confirm-text")?.textContent).toContain(
			"pg-17-prod",
		);
	});

	test("a review with a pick shows what will be sent, its images go only through the app's file route (a dotted id gets none), and a page is a pointer", async () => {
		const root = await draw(row(reply(REVIEW)));
		const review = shadow(root, "pbs-review");
		const images = [...review.querySelectorAll("img")].map((img) =>
			img.getAttribute("src"),
		);
		// The id of an attached SVG goes the same route as any other file's.
		expect(images).toEqual(["api/files/logo-a", "api/files/comp-svg_1"]);
		expect(review.querySelector("iframe")).toBeNull();
		expect(review.textContent).toContain("proto.html");
		expect(review.textContent).toContain("open it on the computer");
		await click(review.querySelector("[part=submit]"));
		expect(calls).toHaveLength(0);
		expect(root.querySelector(".block-confirm")).not.toBeNull();
	});

	test("a block locked from this page opens again when the owner cancels the answer: the row comes back without the lock", async () => {
		const message = reply(OPTIONS);
		const root = await draw(row(message));
		await click(shadow(root, "pbs-options").querySelector("[part=pick]"));
		await page.act(() => settle());
		expect(slot(root).dataset.state).toBe("answered");
		// A redraw before the server's record reaches the page keeps the lock; the cancel then removes the record.
		await draw(row(message), true);
		expect(slot(root).dataset.state).toBe("answered");
		const recorded = {
			...message,
			answers: [{ block: 0, fields: [["picked", "SQLite"]] as BlockFields }],
		};
		await draw(row(recorded), true);
		expect(slot(root).dataset.state).toBe("answered");
		await draw(row(message), true);
		expect(slot(root).dataset.state).toBe("open");
		// And it takes the answer again.
		await click(shadow(root, "pbs-options").querySelector("[part=pick]"));
		await page.act(() => settle());
		expect(calls).toHaveLength(2);
	});

	test("the server's record may reach the page before its accepted frame, and the cancel still reopens the block", async () => {
		const gate = Promise.withResolvers<BlockReply>();
		nextReply = () => gate.promise;
		const message = reply(OPTIONS);
		const root = await draw(row(message));
		await click(shadow(root, "pbs-options").querySelector("[part=pick]"));
		await draw(
			row({
				...message,
				answers: [{ block: 0, fields: [["picked", "SQLite"]] }],
			}),
			true,
		);
		gate.resolve({ ok: true });
		await page.act(() => settle());
		expect(slot(root).dataset.state).toBe("answered");
		await draw(row(message), true);
		expect(slot(root).dataset.state).toBe("open");
	});

	test("a refusal opens the block again with the reason, and a second answer can follow", async () => {
		nextReply = async () => ({ ok: false, code: "not_accepted" });
		const root = await draw(row(reply(OPTIONS)));
		await click(shadow(root, "pbs-options").querySelector("[part=pick]"));
		await page.act(() => settle());
		expect(slot(root).dataset.state).toBe("open");
		expect(noteOf(root)).toBe(
			"Not sent. Check the connection, then try again.",
		);
		nextReply = async () => ({ ok: true });
		await click(shadow(root, "pbs-options").querySelector("[part=pick]"));
		await page.act(() => settle());
		expect(calls).toHaveLength(2);
		expect(slot(root).dataset.state).toBe("answered");
	});

	test("an answer the server finds an earlier one for is locked by the server's record, and the block opens when that record goes", async () => {
		nextReply = async () => ({ ok: false, code: "answered" });
		const message = reply(OPTIONS);
		const root = await draw(row(message));
		await click(shadow(root, "pbs-options").querySelector("[part=pick]"));
		await page.act(() => settle());
		expect(slot(root).dataset.state).toBe("open");
		const answers = [
			{ block: 0, fields: [["picked", "Postgres"]] as BlockFields },
		];
		await draw(row({ ...message, answers }), true);
		expect(slot(root).dataset.state).toBe("answered");
		// The other device's send failed: the row comes back without the answer.
		await draw(row(message), true);
		expect(slot(root).dataset.state).toBe("open");
	});

	test("a message that can no longer be answered says to type instead", async () => {
		nextReply = async () => ({ ok: false, code: "unanswerable" });
		const root = await draw(row(reply(OPTIONS)));
		await click(shadow(root, "pbs-options").querySelector("[part=pick]"));
		await page.act(() => settle());
		expect(noteOf(root)).toContain("Type your answer instead");
		expect(slot(root).dataset.state).toBe("open");
	});

	test("the lock the server records reaches a block that was open, and a locked block shows what was sent", async () => {
		const message = reply(OPTIONS);
		const root = await draw(row(message));
		expect(slot(root).dataset.state).toBe("open");
		await draw(
			row({
				...message,
				answers: [{ block: 0, fields: [["picked", "Postgres"]] }],
			}),
			true,
		);
		expect(slot(root).dataset.state).toBe("answered");
		expect(
			(root.querySelector("pbs-options") as { answered?: BlockFields })
				.answered,
		).toEqual([["picked", "Postgres"]]);
		// A locked block takes no second tap.
		await click(shadow(root, "pbs-options").querySelector("[part=pick]"));
		expect(calls).toHaveLength(0);
	});

	test("a block is read only where the row takes no answer: archived, a thread, a live reply, a pending text, an owner's message, a card between agents", async () => {
		const pending = {
			id: "p1",
			room: "app:agent.guide",
			text: OPTIONS,
			files: [],
		};
		const rows = [
			row(reply(OPTIONS), false),
			<LiveRow
				key="live"
				message={reply(OPTIONS, { id: 0, live: "t1" })}
				character={undefined}
			/>,
			<PendingRow key="pending" pending={pending as never} />,
			row(reply(OPTIONS, { kind: "owner", agent: undefined, author: "Ada" })),
			row(
				reply(OPTIONS, {
					intercom: {
						kind: "sent",
						peer: { name: "scout", displayName: "Scout" },
					},
				}),
			),
		];
		for (const [index, one] of rows.entries()) {
			const root = await draw(<span key={index}>{one}</span>);
			const drawn = root.querySelector(".block-answer");
			// An intercom card draws its text only when opened; the others draw the block, disabled.
			if (drawn) {
				expect(drawn.getAttribute("data-state")).toBe("readonly");
				expect(drawn.querySelector("[inert]")).not.toBeNull();
				await click(shadow(root, "pbs-options").querySelector("[part=pick]"));
			}
		}
		expect(calls).toHaveLength(0);
	});

	test("a room's log offers its blocks only in a room that takes messages", async () => {
		const config = {
			title: "Console",
			panes: ["rooms"],
			timeZone: "UTC",
			look: "modern",
		} as never;
		const room = (key: string, readOnly: boolean) => {
			const view = {
				key,
				kind: readOnly ? "thread" : "agent",
				name: key,
				displayName: key,
				home: false,
				readOnly,
				mode: { yolo: false, longRunning: false },
				typing: false,
				stoppable: false,
			};
			store.dispatch({ type: "rooms_loaded", rooms: [view as never] });
			store.dispatch({
				type: "history_loaded",
				room: key,
				messages: [reply(OPTIONS, { room: key })],
				more: false,
				cards: [],
				older: false,
			});
		};
		room("app:agent.writable", false);
		room("app:thread.read-only", true);
		for (const [key, state] of [
			["app:agent.writable", "open"],
			["app:thread.read-only", "readonly"],
		] as const) {
			renders++;
			await page.render(
				<ConfigContext.Provider value={config}>
					<RoomLog
						key={renders}
						roomKey={key}
						enterAfter={undefined}
						quotable
					/>
				</ConfigContext.Provider>,
			);
			await page.act(() => settle(80));
			expect(slot(page.container).dataset.state).toBe(state);
		}
	});
}
