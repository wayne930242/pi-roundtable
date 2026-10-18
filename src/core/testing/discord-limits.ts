/** Discord's limits for a Components V2 message and a modal, as of discord-api-types 0.38. */
export const DISCORD_LIMITS = {
	containerChildren: 10,
	componentsPerMessage: 40,
	textPerMessage: 4000,
	rowComponents: 5,
	customId: 100,
	selectOptions: 25,
	selectText: 100,
	placeholder: 150,
	buttonLabel: 80,
	modalComponents: 5,
	modalTitle: 45,
	modalLabel: 45,
	modalDescription: 100,
	textInputValue: 4000,
} as const;

interface Json {
	type?: number;
	content?: string;
	custom_id?: string;
	label?: string;
	description?: string;
	title?: string;
	placeholder?: string;
	value?: string;
	options?: { label: string; value: string; description?: string }[];
	components?: Json[];
	component?: Json;
}

const L = DISCORD_LIMITS;
const CONTAINER = 17;
const ACTION_ROW = 1;
const TEXT_DISPLAY = 10;
const LABEL = 18;

function count(node: Json): number {
	return (
		1 +
		(node.components ?? []).reduce((sum, child) => sum + count(child), 0) +
		(node.component ? count(node.component) : 0)
	);
}

function textOf(node: Json): number {
	return (
		(node.type === TEXT_DISPLAY
			? Math.max(
					Array.from(node.content ?? "").length,
					(node.content ?? "").length,
				)
			: 0) +
		(node.components ?? []).reduce((sum, child) => sum + textOf(child), 0)
	);
}

function check(node: Json, found: string[]): void {
	const over = (what: string, value: string | undefined, max: number) => {
		if (
			value !== undefined &&
			Math.max(Array.from(value).length, value.length) > max
		)
			found.push(`${what} is over ${max} characters`);
	};
	over("custom_id", node.custom_id, L.customId);
	over("placeholder", node.placeholder, L.placeholder);
	if (node.type === 2) over("button label", node.label, L.buttonLabel);
	if (
		node.type === CONTAINER &&
		(node.components?.length ?? 0) > L.containerChildren
	)
		found.push(`a container has ${node.components?.length} children`);
	if (
		node.type === ACTION_ROW &&
		(node.components?.length ?? 0) > L.rowComponents
	)
		found.push(`an action row has ${node.components?.length} components`);
	if (node.type === 3) {
		if ((node.options?.length ?? 0) > L.selectOptions)
			found.push(`a select has ${node.options?.length} options`);
		for (const o of node.options ?? []) {
			over("option label", o.label, L.selectText);
			over("option value", o.value, L.selectText);
			over("option description", o.description, L.selectText);
		}
	}
	if (node.type === LABEL) {
		over("modal label", node.label, L.modalLabel);
		over("modal description", node.description, L.modalDescription);
	}
	if (node.type === 4) over("text input value", node.value, L.textInputValue);
	for (const child of node.components ?? []) check(child, found);
	if (node.component) check(node.component, found);
}

/**
 * The ways a message's components (as `toJSON()`ed) break Discord's limits: container children,
 * components counted with their nested ones, text across text displays, row sizes, select
 * options, label and custom id lengths. Empty when it fits.
 */
export function messageViolations(input: readonly unknown[]): string[] {
	// SAFETY: a builder's `toJSON()` is the API shape `Json` reads.
	const components = input as readonly Json[];
	const found: string[] = [];
	const total = components.reduce((sum, c) => sum + count(c), 0);
	if (total > L.componentsPerMessage)
		found.push(`${total} components (limit ${L.componentsPerMessage})`);
	const text = components.reduce((sum, c) => sum + textOf(c), 0);
	if (text > L.textPerMessage)
		found.push(`${text} characters of text (limit ${L.textPerMessage})`);
	for (const component of components) check(component, found);
	return found;
}

/** The ways a modal (as `toJSON()`ed) breaks Discord's limits. */
export function modalViolations(input: unknown): string[] {
	// SAFETY: a builder's `toJSON()` is the API shape `Json` reads.
	const modal = input as Json;
	const found: string[] = [];
	if ((modal.components?.length ?? 0) > L.modalComponents)
		found.push(`a modal has ${modal.components?.length} components`);
	if (
		Math.max(Array.from(modal.title ?? "").length, (modal.title ?? "").length) >
		L.modalTitle
	)
		found.push(`the modal title is over ${L.modalTitle} characters`);
	for (const child of modal.components ?? []) check(child, found);
	return found;
}
