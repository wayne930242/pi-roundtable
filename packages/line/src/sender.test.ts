import { expect, test } from "bun:test";
import {
	checkSenderOptions,
	SENDER_DEFAULTS,
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
	expect(validateSender({ name: "王小明｜專人客服" })).toBeDefined();
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
