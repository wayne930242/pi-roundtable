import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CATALOG, type CharacterSpec } from "pi-roundtable/characters";
import { partial } from "pi-roundtable/testing";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PromptFrame } from "../src/api-types.ts";
import {
	answerOf,
	describeAnswer,
	NO_PICK,
	PromptCard,
} from "./components/cards.tsx";
import { systemLine } from "./components/message-row.tsx";
import { openPage, releaseDom } from "./dom.ts";
import { store } from "./lib/app-store.ts";
import { fuzzyScore } from "./lib/fuzzy.ts";
import { loadKit } from "./lib/kit.ts";
import { initLook } from "./lib/look.ts";
import { setPresentation } from "./lib/messages.ts";
import type { CardState } from "./lib/rooms.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { describeRecurrence } from "./pages/schedules.tsx";

setPresentation({ title: "Console", panes: ["rooms"], timeZone: "UTC" });
setConnection(partial<AppConnection>({ send: () => true }));

const card = (
	frame: PromptFrame,
	over: Partial<CardState> = {},
): CardState => ({
	room: "app:agent.guide",
	frame,
	after: 0,
	...over,
});

const render = (state: CardState) =>
	renderToStaticMarkup(createElement(PromptCard, { card: state }));

test("an approval card shows its text, its details and a button for each answer", () => {
	const html = render(
		card({
			id: "p1",
			kind: "approval",
			title: "Run the deploy?",
			message: "Deploy **v1.4.2**.",
			purpose: "action",
			approval: {
				action: "deploy",
				tool: "bash",
				input: { command: "bun run deploy" },
				files: [{ path: "/srv/app/deploy.lock", bytes: 12 }],
				copy: { label: "command", text: "bun run deploy" },
			},
		}),
	);
	expect(html).toContain("Run the deploy?");
	expect(html).toContain("<strong>v1.4.2</strong>");
	expect(html).toContain("bun run deploy");
	expect(html).toContain("/srv/app/deploy.lock");
	expect(html).toContain("Copy command");
	expect(html).toContain(">Approve<");
	expect(html).toContain(">Decline<");
});

test("a turn's time-limit card uses its own words, and an unworded one says Continue and Stop", () => {
	const wording = {
		approve: "Keep going",
		decline: "Halt",
		footer: "Halting ends the turn.",
		approved: "Going on",
		declined: "Halted",
	};
	const base = {
		id: "p2",
		kind: "approval" as const,
		title: "Time limit reached",
		message: "Ten minutes.",
		purpose: "turn-timeout" as const,
	};
	const worded = render(card({ ...base, wording }));
	expect(worded).toContain(">Keep going<");
	expect(worded).toContain(">Halt<");
	expect(worded).toContain("Halting ends the turn.");
	expect(worded).toContain("prompt-timeout");
	const plain = render(card(base));
	expect(plain).toContain(">Continue<");
	expect(plain).toContain(">Stop turn<");
	// Ended, the card says so in the card's own words.
	const ended = render(card({ ...base, wording }, { outcome: "approved" }));
	expect(ended).toContain("Going on");
	expect(ended).toContain('data-ended="true"');
});

test("a late card says the turn stopped waiting, and an ended one drops the hint", () => {
	const frame: PromptFrame = {
		id: "p3",
		kind: "approval",
		title: "Publish?",
		message: "Publish the post.",
		purpose: "action",
		late: true,
	};
	expect(render(card(frame))).toContain("The turn stopped waiting");
	expect(render(card(frame))).toContain(">Late<");
	expect(render(card(frame, { outcome: "declined" }))).not.toContain(">Late<");
});

test("a card names who else may approve it, and a speaker-only card says so", () => {
	const html = render(
		card({
			id: "p4",
			kind: "approval",
			title: "Send?",
			message: "Send it.",
			purpose: "action",
			speakerOnly: true,
			approvers: ["Bea", "Gus"],
		}),
	);
	expect(html).toContain("Only the person this turn answers can approve it.");
	expect(html).toContain("Bea, Gus can approve this");
});

test("a question card offers Other only when the question allows it, and Cancel always", () => {
	const ask = (allowOther: boolean) =>
		render(
			card({
				id: "q1",
				kind: "ask",
				title: "Which?",
				question: "Which region?",
				options: [{ label: "eu" }, { label: "us" }],
				multi: false,
				allowOther,
			}),
		);
	expect(ask(true)).toContain(">Other<");
	expect(ask(false)).not.toContain(">Other<");
	expect(ask(false)).toContain(">Cancel<");
	expect(ask(false)).toContain('type="radio"');
});

test("a question with no options is a text box, and a multiple choice has checkboxes", () => {
	const free = render(
		card({
			id: "q2",
			kind: "questionnaire",
			title: "Questions",
			questions: [
				{
					question: "Which?",
					options: [{ label: "a" }],
					multi: true,
					allowOther: false,
				},
				{
					question: "Anything else?",
					options: [],
					multi: false,
					allowOther: false,
				},
			],
		}),
	);
	expect(free).toContain('type="checkbox"');
	expect(free).toContain("<textarea");
	expect(free).toContain("Send answers");
});

test("an answer is only made once a choice, or the person's own words, are given", () => {
	const single = {
		options: [{ label: "a" }, { label: "b" }],
		multi: false,
		allowOther: true,
	};
	expect(answerOf(single, NO_PICK)).toBeUndefined();
	expect(answerOf(single, { choices: ["a"], other: false, text: "" })).toEqual({
		choices: ["a"],
	});
	// Other with no words is not an answer yet; with words it carries them.
	expect(
		answerOf(single, { choices: [], other: true, text: "  " }),
	).toBeUndefined();
	expect(
		answerOf(single, { choices: [], other: true, text: " mine " }),
	).toEqual({
		choices: [],
		text: "mine",
	});
	const free = { options: [], multi: false, allowOther: false };
	expect(
		answerOf(free, { choices: [], other: false, text: "" }),
	).toBeUndefined();
	expect(answerOf(free, { choices: [], other: false, text: "words" })).toEqual({
		choices: [],
		text: "words",
	});
});

test("the server's own lines in a room are shown in the page's words", () => {
	expect(systemLine("Conversation started over")).toEqual({
		icon: "reset",
		text: "Conversation started over",
	});
	expect(systemLine("Yolo mode approved: git push origin main")).toEqual({
		icon: "bolt",
		text: "Yolo mode approved: git push origin main",
	});
	expect(systemLine("Something else").icon).toBe("list");
	setPresentation({
		title: "Console",
		panes: ["rooms"],
		timeZone: "UTC",
		messages: {
			"Yolo mode approved: {action}":
				"Yolo \u6a21\u5f0f\u5df2\u6838\u51c6\uff1a{action}",
		},
	});
	expect(systemLine("Yolo mode approved: ls").text).toBe(
		"Yolo \u6a21\u5f0f\u5df2\u6838\u51c6\uff1als",
	);
	setPresentation({ title: "Console", panes: ["rooms"], timeZone: "UTC" });
});

test("the room switcher matches letters in order and prefers word starts and short names", () => {
	expect(fuzzyScore("zz", "Scout")).toBeUndefined();
	expect(fuzzyScore("", "Scout")).toBe(0);
	const scout = fuzzyScore("sc", "Scout");
	const schedules = fuzzyScore("sc", "Schedules");
	expect(scout).toBeDefined();
	expect(schedules).toBeDefined();
	// The shorter name that holds the letters at its start is the closer match.
	expect((scout ?? 0) > (schedules ?? 0)).toBe(true);
	// Letters that start words beat letters scattered in the middle.
	expect(
		(fuzzyScore("wd", "Weekly digest") ?? 0) >
			(fuzzyScore("wd", "Showdown") ?? 0),
	).toBe(true);
});

test("a schedule's recurrence reads as words", () => {
	setPresentation({ title: "Console", panes: ["schedules"], timeZone: "UTC" });
	expect(
		describeRecurrence({
			kind: "every",
			time: "07:30",
			everyDays: 1,
			startDate: "2026-10-28",
		}),
	).toBe("Every day at 07:30");
	expect(
		describeRecurrence({
			kind: "every",
			time: "07:30",
			everyDays: 3,
			startDate: "2026-10-28",
		}),
	).toBe("Every 3 days at 07:30");
	expect(
		describeRecurrence({
			kind: "weekly",
			time: "09:00",
			weekdays: ["mon", "thu"],
		}),
	).toBe("Mon, Thu at 09:00");
	expect(
		describeRecurrence({ kind: "once", date: "2026-11-02", time: "10:00" }),
	).toBe("Once on 2026-11-02 at 10:00");
	expect(describeRecurrence(null)).toBe("");
});

test("an answered card is described by the options picked and the person's own words", () => {
	expect(describeAnswer({ choices: ["Blue", "Green"] })).toBe("Blue, Green");
	expect(describeAnswer({ choices: ["Blue"], text: " warm  " })).toBe(
		"Blue, warm",
	);
	expect(describeAnswer({ choices: [], text: "both" })).toBe("both");
});

const knight: CharacterSpec = {
	v: 1,
	class: "knight",
	...CATALOG.classes.knight.preset,
};

/** Runs `work` on a page of its own, with the kit loaded and the guide's room holding the knight. */
async function onPage(
	look: "modern" | "camelot",
	work: (page: Awaited<ReturnType<typeof openPage>>) => Promise<void>,
): Promise<void> {
	const kit = await loadKit();
	const page = await openPage();
	try {
		localStorage.clear();
		initLook(look);
		store.dispatch({
			type: "rooms_loaded",
			rooms: [
				{
					key: "app:agent.guide",
					kind: "agent",
					name: "guide",
					displayName: "Guide",
					home: true,
					readOnly: false,
					mode: { yolo: false, longRunning: false },
					typing: false,
					stoppable: false,
					character: knight,
				},
			],
		});
		expect(kit).toBeDefined();
		await work(page);
	} finally {
		await page.unmount();
		initLook("modern");
		await releaseDom();
	}
}

const approval: PromptFrame = {
	id: "seal1",
	kind: "approval",
	title: "Run the deploy?",
	message: "Deploy.",
	purpose: "action",
};

test("under Camelot an approved approval card keeps a wax seal in the room agent's accent, and under modern it has none", async () => {
	const kit = await loadKit();
	await onPage("camelot", async (page) => {
		const approved = card(approval, { outcome: "approved" });
		await page.render(createElement(PromptCard, { card: approved }));
		const seal = page.container.querySelector<HTMLElement>(".wax-seal");
		expect(seal).not.toBeNull();
		expect(seal?.style.getPropertyValue("--agent-accent")).toBe(
			kit.accentOf(knight, "camelot-light"),
		);
		// It stays on the closed card: the card is ended and still carries it after another render.
		await page.render(
			createElement(PromptCard, { card: { ...approved, note: "ok" } }),
		);
		expect(page.container.querySelectorAll(".wax-seal")).toHaveLength(1);
		// A card that is open, declined or not an approval gets none.
		for (const other of [
			card(approval),
			card(approval, { outcome: "declined" }),
			card(
				{
					id: "q1",
					kind: "ask",
					title: "Which?",
					question: "Which region?",
					options: [{ label: "eu" }],
					multi: false,
					allowOther: false,
				},
				{ outcome: "answered" },
			),
		]) {
			await page.render(createElement(PromptCard, { card: other }));
			expect(page.container.querySelector(".wax-seal")).toBeNull();
		}
	});
	await onPage("modern", async (page) => {
		await page.render(
			createElement(PromptCard, {
				card: card(approval, { outcome: "approved" }),
			}),
		);
		expect(page.container.querySelector(".wax-seal")).toBeNull();
	});
});

test("the wax seal stamps in with an animation, and under reduced motion it has none", async () => {
	await onPage("camelot", async (page) => {
		const sealed = createElement(PromptCard, {
			card: card(approval, { outcome: "approved" }),
		});
		const style = document.createElement("style");
		style.textContent = readFileSync(
			new URL("./styles/camelot.css", import.meta.url),
			"utf8",
		);
		document.head.append(style);
		const animation = () => {
			const seal = page.container.querySelector(".wax-seal");
			if (!seal) throw new Error("no seal");
			return getComputedStyle(seal).animationName;
		};
		await page.render(sealed);
		expect(animation()).toBe("seal-stamp");
		const device = (
			window as unknown as {
				happyDOM?: { settings: { device: { prefersReducedMotion: string } } };
			}
		).happyDOM?.settings.device;
		if (!device) throw new Error("no happy-dom settings");
		device.prefersReducedMotion = "reduce";
		try {
			// A computed style is kept per element, so the seal is drawn anew.
			await page.render(null);
			await page.render(sealed);
			expect(animation()).toBe("none");
		} finally {
			device.prefersReducedMotion = "no-preference";
		}
	});
});
