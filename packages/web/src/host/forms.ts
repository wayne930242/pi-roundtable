import { PluginError } from "pi-roundtable";
import type {
	FormField,
	FormSpec,
	FormValues,
	HostAction,
} from "../web-app.ts";

/** The limits of what a host puts on a card, a header or a form. */
const LIMITS = {
	title: 200,
	label: 120,
	body: 20_000,
	links: 10,
	buttons: 10,
	fields: 20,
	options: 1_000,
	textMax: 500,
	textareaMax: 8_000,
} as const;

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const FIELD_NAME = /^[A-Za-z0-9_]{1,40}$/;
const TONES = new Set(["note", "ok", "warn", "risk"]);
const STATES = new Set(["open", "working", "done", "superseded", "expired"]);

const fail = (what: string): never => {
	throw new PluginError(`web app: ${what}`);
};

/** Whether a link may be put on a card: `https`, or a path of this origin. */
export function safeLink(url: string): boolean {
	if (url.startsWith("/")) return !url.startsWith("//") && !url.includes("\\");
	return URL.parse(url)?.protocol === "https:";
}

function checkField(field: FormField, where: string): void {
	if (!FIELD_NAME.test(field.name))
		fail(
			`${where}: field name ${JSON.stringify(field.name)} must match [A-Za-z0-9_]{1,40}`,
		);
	if (typeof field.label !== "string" || field.label.length > LIMITS.label)
		fail(
			`${where}: field ${field.name} needs a label of at most ${LIMITS.label} characters`,
		);
	if (field.type === "select" || field.type === "multiselect") {
		const { options } = field;
		if (!Array.isArray(options) || options.length > LIMITS.options)
			fail(
				`${where}: field ${field.name} takes at most ${LIMITS.options} options`,
			);
		const values = new Set(options.map((option) => option.value));
		if (values.size !== options.length)
			fail(`${where}: field ${field.name} lists a value twice`);
		const initial =
			field.initial === undefined
				? []
				: typeof field.initial === "string"
					? [field.initial]
					: field.initial;
		if (field.type === "select" && initial.length > 1)
			fail(`${where}: select ${field.name} takes one initial value`);
		for (const value of initial)
			if (!values.has(value))
				fail(
					`${where}: field ${field.name}'s initial value ${JSON.stringify(value)} is not an option`,
				);
	} else if (!["text", "textarea", "url"].includes(field.type))
		fail(
			`${where}: field ${field.name} has the unknown type ${String(field.type)}`,
		);
}

function checkSpec(form: FormSpec, where: string): void {
	if (typeof form.title !== "string" || typeof form.submit !== "string")
		fail(`${where}: a form needs a title and a submit label`);
	if (!Array.isArray(form.fields) || form.fields.length > LIMITS.fields)
		fail(`${where}: a form takes at most ${LIMITS.fields} fields`);
	const names = new Set<string>();
	for (const field of form.fields) {
		checkField(field, where);
		if (names.has(field.name))
			fail(`${where}: field ${field.name} is listed twice`);
		names.add(field.name);
	}
}

/** Throws a `PluginError` naming what is wrong with a list of actions a host offers; returns them. */
export function checkActions(
	actions: readonly HostAction[],
	where: string,
): readonly HostAction[] {
	if (actions.length > LIMITS.buttons)
		fail(`${where}: at most ${LIMITS.buttons} buttons`);
	const ids = new Set<string>();
	for (const action of actions) {
		if (!ID.test(action.id))
			fail(
				`${where}: button id ${JSON.stringify(action.id)} must match [A-Za-z0-9_.:-]{1,64}`,
			);
		if (ids.has(action.id))
			fail(`${where}: button ${action.id} is listed twice`);
		ids.add(action.id);
		if (typeof action.label !== "string" || action.label.length > LIMITS.label)
			fail(
				`${where}: button ${action.id} needs a label of at most ${LIMITS.label} characters`,
			);
		if (action.confirm !== undefined && action.confirm.length > LIMITS.body)
			fail(`${where}: button ${action.id}'s confirmation is too long`);
		if (action.form) checkSpec(action.form, `${where} button ${action.id}`);
	}
	return actions;
}

/** Throws a `PluginError` for a card a host may not put in a room. */
export function checkCard(card: {
	title: string;
	body: string;
	tone?: string | undefined;
	state?: string | undefined;
	links?: readonly { label: string; url: string }[] | undefined;
	buttons?: readonly HostAction[] | undefined;
}): void {
	if (typeof card.title !== "string" || card.title.length > LIMITS.title)
		fail(`a card's title is at most ${LIMITS.title} characters`);
	if (typeof card.body !== "string" || card.body.length > LIMITS.body)
		fail(`a card's body is at most ${LIMITS.body} characters`);
	if (card.tone !== undefined && !TONES.has(card.tone))
		fail(`a card's tone is note, ok, warn or risk`);
	if (card.state !== undefined && !STATES.has(card.state))
		fail(`a card's state is open, working, done, superseded or expired`);
	const links = card.links ?? [];
	if (links.length > LIMITS.links)
		fail(`a card takes at most ${LIMITS.links} links`);
	for (const link of links)
		if (!safeLink(link.url))
			fail(
				`a card's link ${JSON.stringify(link.url)} must be https or a path of this origin`,
			);
	checkActions(card.buttons ?? [], "a card");
}

/** The buttons a card shows: only while it is open (or has no state), since a settled card has nothing left to press. */
export const pressable = (card: { state?: string | undefined }): boolean =>
	card.state === undefined || card.state === "open";

/**
 * What a form's input comes to: the values kept, or the first thing wrong with it and the field it
 * is about. Every field of the form is checked; a name the form does not have is refused, so an
 * action cannot be handed values it never offered.
 */
export function checkInput(
	form: FormSpec | undefined,
	input: FormValues,
):
	| { ok: true; values: FormValues }
	| { ok: false; error: string; field?: string } {
	if (!form) {
		return Object.keys(input).length === 0
			? { ok: true, values: {} }
			: { ok: false, error: "This action takes no form." };
	}
	const known = new Set(form.fields.map((field) => field.name));
	for (const name of Object.keys(input))
		if (!known.has(name))
			return { ok: false, error: "The form has no such field.", field: name };
	const values: Record<string, string | readonly string[]> = {};
	for (const field of form.fields) {
		const given = input[field.name];
		const empty =
			given === undefined ||
			(typeof given === "string" ? given.trim() === "" : given.length === 0);
		if (empty) {
			if (field.required)
				return {
					ok: false,
					error: "This field is required.",
					field: field.name,
				};
			continue;
		}
		if ("options" in field) {
			const allowed = new Set(field.options.map((option) => option.value));
			if (field.type === "multiselect") {
				if (
					typeof given === "string" ||
					new Set(given).size !== given.length ||
					!given.every((value) => allowed.has(value))
				)
					return {
						ok: false,
						error: "Choose from the list.",
						field: field.name,
					};
				values[field.name] = [...given];
			} else {
				if (typeof given !== "string" || !allowed.has(given))
					return {
						ok: false,
						error: "Choose from the list.",
						field: field.name,
					};
				values[field.name] = given;
			}
			continue;
		}
		if (typeof given !== "string")
			return {
				ok: false,
				error: "This field takes one value.",
				field: field.name,
			};
		const max =
			field.max ??
			(field.type === "textarea" ? LIMITS.textareaMax : LIMITS.textMax);
		if (given.length > max)
			return {
				ok: false,
				error: `This field takes at most ${max} characters.`,
				field: field.name,
			};
		if (field.type === "url") {
			const protocol = URL.parse(given.trim())?.protocol;
			if (protocol !== "https:" && protocol !== "http:")
				return { ok: false, error: "Give a web address.", field: field.name };
			values[field.name] = given.trim();
			continue;
		}
		values[field.name] = given;
	}
	return { ok: true, values };
}
