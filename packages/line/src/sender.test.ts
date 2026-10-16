import { expect, test } from "bun:test";
import {
	checkSenderOptions,
	SENDER_DEFAULTS,
	SENDER_NAME_MAX,
	type SenderNameProblem,
	senderNameProblem,
	validateSender,
} from "./sender.ts";

const refusal = (sender: unknown, options = SENDER_DEFAULTS) => {
	try {
		validateSender(sender as never, options);
	} catch (error) {
		return error as { code: string; message: string };
	}
	return undefined;
};

test("a sender with a name and an https icon is accepted as given; none is no sender", () => {
	expect(validateSender(undefined)).toBeUndefined();
	const sender = {
		name: "Ada Lovelace",
		iconUrl: "https://icons.example.test/staff.png",
	};
	expect(validateSender(sender)).toEqual(sender);
	expect(validateSender({ name: "Ada" })).toEqual({ name: "Ada" });
	expect(
		validateSender({ iconUrl: "https://icons.example.test/a.png" }),
	).toEqual({ iconUrl: "https://icons.example.test/a.png" });
});

test("a name is 1 to 20 characters, counted as characters and not as bytes or code units", () => {
	expect(validateSender({ name: "a".repeat(20) })).toBeDefined();
	expect(refusal({ name: "a".repeat(21) })).toMatchObject({
		code: "bad_sender",
	});
	// Twenty characters outside the Basic Multilingual Plane are still twenty characters.
	expect(validateSender({ name: "😀".repeat(20) })).toBeDefined();
	expect(refusal({ name: "😀".repeat(21) })).toMatchObject({
		code: "bad_sender",
	});
	expect(validateSender({ name: "Zoë｜Desk, さくら" })).toBeDefined();
	for (const name of ["", "   ", " Ada", "Ada ", "Ada\nLovelace", "Ada\u0000"])
		expect(refusal({ name })).toMatchObject({ code: "bad_sender" });
	expect(refusal({ name: 42 })).toMatchObject({ code: "bad_sender" });
});

test("the words LINE and LY are refused whole and in any case, and other names that contain them are not", () => {
	for (const name of [
		"LINE",
		"line",
		"Ada from LINE",
		"Support-Line",
		"ly",
		"A LY B",
	])
		expect(refusal({ name })).toMatchObject({ code: "bad_sender" });
	for (const name of ["Online", "Sally", "Pipeline", "Kelly", "Lyra"])
		expect(refusal({ name })).toBeUndefined();
});

test("a forbidden word next to letters of another script, or in full-width letters, is still the word (R6-F004)", () => {
	for (const name of [
		"LINEさくら",
		"さくらLINE",
		"さくら LY",
		"ＬＩＮＥさくら",
		"ｌｉｎｅ",
	])
		expect(refusal({ name })).toMatchObject({ code: "bad_sender" });
	for (const name of ["さくらOnline", "Sallyさくら", "さくら", "Zoëさくら"])
		expect(refusal({ name })).toBeUndefined();
});

test("the forbidden words are configurable", () => {
	const options = { forbiddenWords: ["Acme"] };
	expect(refusal({ name: "acme desk" }, options)).toMatchObject({
		code: "bad_sender",
	});
	expect(refusal({ name: "LINE" }, options)).toBeUndefined();
	expect(() => checkSenderOptions({ forbiddenWords: [] })).not.toThrow();
	expect(() => checkSenderOptions({ forbiddenWords: [""] })).toThrow(
		"forbiddenWords",
	);
	expect(() => checkSenderOptions({ nope: 1 } as never)).toThrow("sender.nope");
});

test("an icon is an https URL of at most 2000 characters, without credentials", () => {
	const base = "https://icons.example.test/";
	expect(
		validateSender({ iconUrl: `${base}${"a".repeat(2000 - base.length)}` }),
	).toBeDefined();
	for (const iconUrl of [
		`${base}${"a".repeat(2001 - base.length)}`,
		"http://icons.example.test/a.png",
		"ftp://icons.example.test/a.png",
		"https://user:pass@icons.example.test/a.png",
		"not a url",
		"",
		7,
	])
		expect(refusal({ iconUrl })).toMatchObject({ code: "bad_sender" });
});

test("a sender with neither part, or with anything else, is refused, and the message never quotes the value", () => {
	expect(refusal({})).toMatchObject({ code: "bad_sender" });
	expect(refusal({ name: "Ada", extra: 1 })).toMatchObject({
		code: "bad_sender",
	});
	expect(refusal("Ada")).toMatchObject({ code: "bad_sender" });
	expect(refusal([])).toMatchObject({ code: "bad_sender" });
	expect(
		refusal({ name: "SECRET-NAME-THAT-IS-WAY-TOO-LONG" })?.message,
	).not.toContain("SECRET");
	expect(
		refusal({ iconUrl: "http://SECRET.example.test" })?.message,
	).not.toContain("SECRET");
});

test("senderNameProblem names why a name is refused, one code of each kind, and nothing for a name LINE takes", () => {
	const cases: [string, SenderNameProblem | undefined][] = [
		["Ada Lovelace", undefined],
		["a".repeat(SENDER_NAME_MAX), undefined],
		["😀".repeat(SENDER_NAME_MAX), undefined],
		["", "empty"],
		["   ", "empty"],
		[" Ada", "edge_space"],
		["Ada\u3000", "edge_space"],
		["a".repeat(SENDER_NAME_MAX + 1), "too_long"],
		["Ada\nLovelace", "control_character"],
		["Ada\u007f", "control_character"],
		["Ada from LINE", "forbidden_word"],
		["ＬＩＮＥさくら", "forbidden_word"],
		["Online", undefined],
	];
	for (const [name, problem] of cases)
		expect(senderNameProblem(name)).toBe(problem);
	expect(senderNameProblem("acme desk", { forbiddenWords: ["Acme"] })).toBe(
		"forbidden_word",
	);
	expect(
		senderNameProblem("LINE", { forbiddenWords: ["Acme"] }),
	).toBeUndefined();
});

test("senderNameProblem never throws, and reports the first problem in a fixed order", () => {
	expect(senderNameProblem(42 as never)).toBe("empty");
	expect(senderNameProblem(undefined as never)).toBe("empty");
	// Several problems at once: spacing, then length, then control characters, then words.
	expect(senderNameProblem(` ${"a".repeat(30)}\n`)).toBe("edge_space");
	expect(senderNameProblem(`${"a".repeat(30)}\u0000`)).toBe("too_long");
	expect(senderNameProblem("LINE\u0000")).toBe("control_character");
});

test("C1 control characters are refused like C0 and DEL, and the neighbouring printable characters are not", () => {
	for (const code of [0x80, 0x85, 0x9f]) {
		const name = `Ada${String.fromCharCode(code)}`;
		expect(senderNameProblem(name)).toBe("control_character");
		expect(refusal({ name })).toMatchObject({
			code: "bad_sender",
			message: "line: a sender name has no control characters",
		});
	}
	expect(senderNameProblem("Ada\u00a0B")).toBeUndefined();
	expect(senderNameProblem("Ada\u00a1")).toBeUndefined();
});

test("validateSender keeps its English message for each problem", () => {
	const messages: Record<string, string> = {
		"": "line: a sender name is a non-empty string",
		" Ada": "line: a sender name has no leading or trailing space",
		["a".repeat(21)]: "line: a sender name is at most 20 characters",
		"Ada\u0000": "line: a sender name has no control characters",
		LINE: "line: a sender name may not use a word LINE refuses",
	};
	for (const [name, message] of Object.entries(messages))
		expect(refusal({ name })).toMatchObject({ code: "bad_sender", message });
});

test("the default sender options cannot be changed by a caller", () => {
	expect(Object.isFrozen(SENDER_DEFAULTS)).toBe(true);
	expect(Object.isFrozen(SENDER_DEFAULTS.forbiddenWords)).toBe(true);
	expect(() =>
		(SENDER_DEFAULTS.forbiddenWords as string[]).push("Acme"),
	).toThrow();
	expect(() => {
		(SENDER_DEFAULTS as { forbiddenWords: string[] }).forbiddenWords = [];
	}).toThrow();
	expect(senderNameProblem("LINE")).toBe("forbidden_word");
	expect(senderNameProblem("Acme")).toBeUndefined();
});

test("senderNameProblem takes options without a word list as the defaults, and still never throws", () => {
	for (const options of [
		{},
		{ forbiddenWords: undefined },
		{ forbiddenWords: "LINE" },
	])
		expect(senderNameProblem("LINE", options as never)).toBe("forbidden_word");
	expect(senderNameProblem("Ada", {} as never)).toBeUndefined();
	expect(senderNameProblem("Ada", null as never)).toBeUndefined();
	expect(senderNameProblem("LINE", null as never)).toBe("forbidden_word");
});
