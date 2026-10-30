import { expect, test } from "bun:test";
import type { FormSpec, HostAction } from "../web-app.ts";
import {
	checkActions,
	checkCard,
	checkInput,
	pressable,
	safeLink,
} from "./forms.ts";

const options = [
	{ value: "ada", label: "Ada" },
	{ value: "mel", label: "Mel" },
];

const withField = (field: object): HostAction[] => [
	{
		id: "go",
		label: "Go",
		form: { title: "T", submit: "S", fields: [field as never] },
	},
];

test("a link with a tab, newline or space is no path of this origin", () => {
	expect(safeLink("/\t/evil.example")).toBe(false);
	expect(safeLink("/\n/evil.example")).toBe(false);
	expect(safeLink("/rooms/a")).toBe(true);
});

test("a select or multiselect starts from options it has, and its search is true or false", () => {
	const select = { name: "owner", label: "Owner", type: "select", options };
	expect(() =>
		checkActions(
			withField({ ...select, initial: "mel", search: true }),
			"a card",
		),
	).not.toThrow();
	expect(() =>
		checkActions(withField({ ...select, initial: "zed" }), "a card"),
	).toThrow(/not an option/);
	expect(() =>
		checkActions(withField({ ...select, initial: ["ada", "mel"] }), "a card"),
	).toThrow(/one initial value/);
	expect(() =>
		checkActions(withField({ ...select, search: "yes" }), "a card"),
	).toThrow(/search is true or false/);
	const many = { ...select, type: "multiselect" };
	expect(() =>
		checkActions(withField({ ...many, initial: ["ada", "mel"] }), "a card"),
	).not.toThrow();
	expect(() =>
		checkActions(withField({ ...many, initial: ["ada", "nobody"] }), "a card"),
	).toThrow(/not an option/);
});

const form: FormSpec = {
	title: "T",
	submit: "S",
	fields: [
		{ name: "owner", label: "Owner", type: "select", required: true, options },
		{ name: "tags", label: "Tags", type: "multiselect", options },
		{ name: "note", label: "Note", type: "text", max: 5 },
		{ name: "site", label: "Site", type: "url" },
	],
};

test("an action's input is what its form offers, each value checked against its field", () => {
	expect(
		checkInput(form, {
			owner: "ada",
			tags: ["mel"],
			note: "hi",
			site: " https://example.com ",
		}),
	).toEqual({
		ok: true,
		values: {
			owner: "ada",
			tags: ["mel"],
			note: "hi",
			site: "https://example.com",
		},
	});
	const refused = (input: object) => checkInput(form, input as never);
	expect(refused({})).toMatchObject({
		ok: false,
		field: "owner",
		error: "This field is required.",
	});
	expect(refused({ owner: "zed" })).toMatchObject({
		ok: false,
		field: "owner",
		error: "Choose from the list.",
	});
	expect(refused({ owner: "ada", tags: "mel" })).toMatchObject({
		ok: false,
		field: "tags",
	});
	expect(refused({ owner: "ada", tags: ["mel", "mel"] })).toMatchObject({
		ok: false,
		field: "tags",
	});
	expect(refused({ owner: "ada", note: "too long" })).toMatchObject({
		ok: false,
		field: "note",
		error: "This field is too long.",
	});
	expect(refused({ owner: "ada", site: "javascript:alert(1)" })).toMatchObject({
		ok: false,
		field: "site",
		error: "Give a web address.",
	});
	expect(refused({ owner: "ada", extra: "x" })).toMatchObject({
		ok: false,
		field: "extra",
	});
	// An action without a form takes no input.
	expect(checkInput(undefined, {})).toEqual({ ok: true, values: {} });
	expect(checkInput(undefined, { a: "b" })).toMatchObject({ ok: false });
});

test("a card's links are https or this origin's paths, and only an open card has buttons", () => {
	const card = { title: "T", body: "B" };
	expect(() =>
		checkCard({
			...card,
			links: [
				{ label: "a", url: "https://example.com" },
				{ label: "b", url: "/console/room/x" },
			],
		}),
	).not.toThrow();
	for (const url of [
		"http://example.com",
		"javascript:alert(1)",
		"//evil.test/x",
		"/a\\b",
		"file:///etc/passwd",
	])
		expect(() => checkCard({ ...card, links: [{ label: "x", url }] })).toThrow(
			/must be https or a path/,
		);
	expect(() => checkCard({ ...card, state: "later" })).toThrow(/state is open/);
	expect(() => checkCard({ ...card, keep: true })).not.toThrow();
	expect(() => checkCard({ ...card, keep: "yes" as never })).toThrow(
		/keep is true or false/,
	);
	expect([undefined, "open"].map((state) => pressable({ state }))).toEqual([
		true,
		true,
	]);
	expect(
		["working", "done", "superseded", "expired"].map((state) =>
			pressable({ state }),
		),
	).toEqual([false, false, false, false]);
});
