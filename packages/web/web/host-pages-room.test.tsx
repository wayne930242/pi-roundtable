import { expect, test } from "bun:test";
import {
	buttonNamed,
	fixture,
	focused,
	hostPagesPage,
	page,
	ROOM,
	roomView,
	said,
	sent,
	settle,
	shown,
} from "./host-pages-fixture.tsx";
import { HostRoomPage } from "./pages/host-room.tsx";

hostPagesPage();

test("a host room shows its header, each author as itself, and its open card, and follows the room's frames while it is open", async () => {
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	const html = page.container.innerHTML;
	expect(page.container.querySelector("h1")?.textContent).toBe("Invoice 4410");
	expect(html).toContain("Written twice today");
	expect(
		page.container.querySelector('a[href="https://example.com/o/4410"]'),
	).not.toBeNull();
	// An outside party's text stays text; the assistant's is Markdown; the notice is a line of its own.
	expect(
		page.container.querySelector('[data-author="external"] .bubble')
			?.textContent,
	).toContain("<b>Hi</b>");
	expect(
		page.container
			.querySelector('[data-author="external"] a')
			?.getAttribute("href"),
	).toBe("https://example.com");
	expect(
		page.container.querySelector('[data-author="assistant"] .bubble strong')
			?.textContent,
	).toBe("checked");
	expect(page.container.querySelector(".host-notice strong")?.textContent).toBe(
		"Mel",
	);
	expect(
		page.container
			.querySelector('[data-author="member"]')
			?.getAttribute("data-mine"),
	).toBe("true");
	// The strip of cards starts folded where the screen is small, with the waiting card named.
	expect(buttonNamed("1 card waiting: Draft ready")).not.toBeNull();
	expect(page.container.querySelector(".host-card")).toBeNull();
	await page.click(buttonNamed("1 card waiting: Draft ready"));
	expect(page.container.querySelector(".host-card h3")?.textContent).toBe(
		"Draft ready",
	);
	expect(buttonNamed("Send reply")).not.toBeNull();
	// The page follows the room and shows its progress.
	expect(sent).toContainEqual({ type: "subscribe", room: ROOM });
	expect(focused.at(-1)).toBe(ROOM);
	await page.render(null);
	expect(sent).toContainEqual({ type: "unsubscribe", room: ROOM });
	expect(focused.at(-1)).toBeUndefined();
});

test("on a wide screen the strip of cards starts open", async () => {
	window.innerWidth = 1280;
	window.innerHeight = 900;
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	expect(page.container.querySelector(".host-card h3")?.textContent).toBe(
		"Draft ready",
	);
});

test("a person who may send both ways has one toggle, on by default, and the message goes the way it is set", async () => {
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	const write = async (text: string) => {
		const box = page.container.querySelector("textarea");
		await page.act(() => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setter?.call(box, text);
			box?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await page.click(buttonNamed("Send"));
		await settle();
	};
	const toggle = () =>
		page.container.querySelector<HTMLElement>('[role="switch"].mode-toggle');
	expect(page.container.querySelectorAll('[role="switch"]')).toHaveLength(1);
	expect(toggle()?.textContent).toBe("@AI");
	expect(toggle()?.getAttribute("aria-checked")).toBe("true");
	// The box says what writing does, not who receives it.
	const box = () => page.container.querySelector("textarea");
	expect(box()?.placeholder).toBe("Ask AI…");
	expect(box()?.getAttribute("aria-label")).toBe("Ask AI…");
	await write("for the agent");
	await page.click(toggle());
	expect(toggle()?.getAttribute("aria-checked")).toBe("false");
	// The label stays, so the control keeps its name; only the state and the box's hint change.
	expect(toggle()?.textContent).toBe("@AI");
	expect(box()?.placeholder).toBe("Write an internal note…");
	await write("for the team");
	expect(said).toEqual([
		{ room: ROOM, text: "for the agent", mode: "turn" },
		{ room: ROOM, text: "for the team", mode: "note" },
	]);
});

test("typing @AI at the start turns the toggle on and sends a turn without the token; @AI elsewhere, in a paste, or in an address does nothing", async () => {
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	const toggle = () =>
		page.container.querySelector<HTMLButtonElement>(
			'[role="switch"].mode-toggle',
		);
	const box = () => page.container.querySelector("textarea");
	const put = async (text: string) => {
		await page.act(() => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setter?.call(box(), text);
			box()?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await settle();
	};
	/** A paste: the paste event, then the text landing in the box. */
	const paste = async (text: string) => {
		await page.act(() => {
			const event = new Event("paste", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "clipboardData", {
				value: { files: [], getData: () => text },
			});
			box()?.dispatchEvent(event);
		});
		await put(text);
	};
	const send = async () => {
		await page.click(buttonNamed("Send"));
		await settle();
	};
	const on = () => toggle()?.getAttribute("aria-checked") === "true";
	// The person's own setting is a note.
	if (on()) await page.click(toggle());
	expect(on()).toBe(false);

	await put("@AI, what is the status?");
	expect(on()).toBe(true);
	expect(toggle()?.disabled).toBe(true);
	expect(box()?.placeholder).toBe("Ask AI…");
	await put("what is the status?");
	expect(on()).toBe(false);
	expect(toggle()?.disabled).toBe(false);
	expect(box()?.placeholder).toBe("Write an internal note…");
	await put("@AI, what is the status?");
	await send();
	// The box is empty again and the toggle is the person's setting.
	expect(on()).toBe(false);

	for (const text of [
		"hey @AI, are you there",
		"mail a@ai.com about it",
		"@AIX is a name",
		"@ai.com is a domain",
	]) {
		await put(text);
		expect(on()).toBe(false);
		await send();
	}

	// A paste into the empty box does not switch it, and the token it carried stays text.
	await paste("@AI forwarded from a customer");
	expect(on()).toBe(false);
	await send();
	// Typing after a paste leaves it ignored while the token stays, and typing the token anew counts.
	await paste("@AI forwarded");
	await put("@AI forwarded, and more");
	expect(on()).toBe(false);
	await put("forwarded, and more");
	await put("@AI forwarded, and more");
	expect(on()).toBe(true);
	await put("");

	expect(said).toEqual([
		{ room: ROOM, text: "what is the status?", mode: "turn" },
		{ room: ROOM, text: "hey @AI, are you there", mode: "note" },
		{ room: ROOM, text: "mail a@ai.com about it", mode: "note" },
		{ room: ROOM, text: "@AIX is a name", mode: "note" },
		{ room: ROOM, text: "@ai.com is a domain", mode: "note" },
		{ room: ROOM, text: "@AI forwarded from a customer", mode: "note" },
	]);
});

test("with the toggle on, a typed leading @AI is still cut from the text, and a room with one way has no such shorthand", async () => {
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	const box = () => page.container.querySelector("textarea");
	const toggle = () =>
		page.container.querySelector<HTMLElement>('[role="switch"].mode-toggle');
	const put = async (text: string) => {
		await page.act(() => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setter?.call(box(), text);
			box()?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await settle();
	};
	if (toggle()?.getAttribute("aria-checked") !== "true")
		await page.click(toggle());
	await put("@ai: please look");
	await page.click(buttonNamed("Send"));
	await settle();
	expect(said).toEqual([{ room: ROOM, text: "please look", mode: "turn" }]);
	await page.render(null);
	said.length = 0;
	fixture.view = roomView({ access: { send: ["note"], act: true } });
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	await put("@AI is only text here");
	await page.click(buttonNamed("Send"));
	await settle();
	expect(said).toEqual([
		{ room: ROOM, text: "@AI is only text here", mode: "note" },
	]);
});

test("a kind that words the two ways has its label on the toggle and its own hints in the box", async () => {
	fixture.view = roomView({
		wording: {
			note: { placeholder: "Write to the team…" },
			turn: {
				label: "Let Atlas answer",
				placeholder: "Say what Atlas should do…",
			},
		},
	});
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	const toggle = page.container.querySelector<HTMLElement>('[role="switch"]');
	expect(toggle?.textContent).toBe("Let Atlas answer");
	// A room opens in the way the person last wrote in; the test before left it on notes.
	if (toggle?.getAttribute("aria-checked") !== "true") await page.click(toggle);
	expect(page.container.querySelector("textarea")?.placeholder).toBe(
		"Say what Atlas should do…",
	);
	await page.click(toggle);
	expect(page.container.querySelector("textarea")?.placeholder).toBe(
		"Write to the team…",
	);
	// A kind that words only one way keeps the console's words for the other.
	await page.render(null);
	fixture.view = roomView({ wording: { turn: { label: "Ask Atlas" } } });
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	expect(page.container.querySelector('[role="switch"]')?.textContent).toBe(
		"Ask Atlas",
	);
	// The last test left this room on notes; turn it on to read the other way's hint.
	const again = page.container.querySelector<HTMLElement>('[role="switch"]');
	if (again?.getAttribute("aria-checked") !== "true") await page.click(again);
	expect(page.container.querySelector("textarea")?.placeholder).toBe("Ask AI…");
});

test("a person who may only read has no box, and one who may only write notes has no choice", async () => {
	fixture.view = roomView({ access: { send: [], act: false } });
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	expect(page.container.querySelector("textarea")).toBeNull();
	expect(page.container.textContent).toContain(
		"You can read this room but not write in it.",
	);
	await page.render(null);
	fixture.view = roomView({ access: { send: ["note"], act: true } });
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	expect(page.container.querySelector('[role="switch"]')).toBeNull();
	// A room open to notes only says so in its box, and does not name itself as the recipient.
	expect(page.container.querySelector("textarea")?.placeholder).toBe(
		"Write an internal note…",
	);
});

test("a room that is not there for this person says so and follows nothing", async () => {
	fixture.view = undefined;
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	expect(page.container.textContent).toContain("This room is not available.");
	expect(sent.filter((frame) => frame.type === "subscribe")).toEqual([]);
});

test("a header action asks first, then reaches the host with the card it came from left out", async () => {
	fixture.acts.push({ ok: true, notice: "Closed." });
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	await page.click(buttonNamed("Close thread"));
	expect(page.container.ownerDocument.body.textContent).toContain("Close it?");
	const confirm = [...document.querySelectorAll("button")].filter(
		(button) => button.textContent?.trim() === "Close thread",
	);
	await page.click(confirm.at(-1) ?? null);
	await settle();
	expect(fixture.requests.at(-1)).toMatchObject({
		method: "POST",
		body: { action: "close", input: {} },
	});
	expect(fixture.requests.at(-1)?.body).not.toHaveProperty("card");
});

test("a card's button carries the card's id", async () => {
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	await page.click(buttonNamed("1 card waiting: Draft ready"));
	await page.click(buttonNamed("Send reply"));
	await settle();
	expect(fixture.requests.at(-1)?.body).toMatchObject({
		action: "send",
		card: "c1",
	});
});

// ── The new-messages divider, the marks of who has read, and telling the server how far the person has read ───
