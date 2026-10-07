import { parse } from "@babel/parser";

/** The parts of a syntax node this edit reads; the parser's own types are not needed beyond these. */
export interface Node {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

/** A configuration this edit cannot change, and why; the message says what to do by hand. */
export class ConfigEditError extends Error {
	override name = "ConfigEditError";
}

const WRAPPERS = new Set([
	"TSSatisfiesExpression",
	"TSAsExpression",
	"TSNonNullExpression",
	"ParenthesizedExpression",
]);

export const child = (node: Node, key: string): Node | undefined => {
	const value = node[key];
	return typeof value === "object" && value !== null
		? (value as Node)
		: undefined;
};

/** The expression under `satisfies`, `as`, `!`, and parentheses. */
export function unwrap(node: Node | undefined): Node | undefined {
	let current = node;
	while (current && WRAPPERS.has(current.type))
		current = child(current, "expression");
	return current;
}

/** A parsed module: its top-level statements, and every comment in it. */
export interface ParsedModule {
	body: Node[];
	comments: Node[];
}

/** The module parsed, or a ConfigEditError saying it does not parse and what to do by hand, `instead`. */
export function parseConfig(
	source: string,
	file: string,
	instead: string,
): ParsedModule {
	try {
		const parsed = parse(source, {
			sourceType: "module",
			plugins: ["typescript"],
		});
		// SAFETY: every node the parser builds has a type, start, and end, which is all Node states.
		return {
			body: parsed.program.body as unknown as Node[],
			comments: (parsed.comments ?? []) as unknown as Node[],
		};
	} catch (error) {
		throw new ConfigEditError(
			`${file} does not parse (${error instanceof Error ? error.message : String(error)}). Fix it, or ${instead}.`,
		);
	}
}

const parseModule = (source: string, file: string): Node[] =>
	parseConfig(source, file, "add the plugin to its list by hand").body;

export const nameOf = (node: Node | undefined): string | undefined => {
	if (node?.type === "Identifier") return node.name as string;
	if (node?.type === "StringLiteral") return node.value as string;
	return undefined;
};

/** Every name the module already binds at its top level, so an import cannot shadow one. */
export function boundNames(body: readonly Node[]): Set<string> {
	const names = new Set<string>();
	for (const statement of body) {
		const declaration =
			statement.type === "ExportNamedDeclaration"
				? child(statement, "declaration")
				: statement;
		if (statement.type === "ImportDeclaration")
			for (const specifier of statement.specifiers as Node[]) {
				const local = nameOf(child(specifier, "local"));
				if (local) names.add(local);
			}
		if (declaration?.type === "VariableDeclaration")
			for (const declarator of declaration.declarations as Node[]) {
				const id = nameOf(child(declarator, "id"));
				if (id) names.add(id);
			}
		const id = nameOf(declaration ? child(declaration, "id") : undefined);
		if (id) names.add(id);
	}
	return names;
}

/** The object the config exports: the default export itself, or the top-level constant it names. */
export function exportedObject(body: readonly Node[]): Node | undefined {
	const exported = body.find(
		(node) => node.type === "ExportDefaultDeclaration",
	);
	const value = unwrap(exported ? child(exported, "declaration") : undefined);
	if (value?.type === "ObjectExpression") return value;
	if (value?.type !== "Identifier") return undefined;
	for (const statement of body) {
		const declaration =
			statement.type === "ExportNamedDeclaration"
				? child(statement, "declaration")
				: statement;
		if (declaration?.type !== "VariableDeclaration") continue;
		for (const declarator of declaration.declarations as Node[]) {
			if (nameOf(child(declarator, "id")) !== value.name) continue;
			const init = unwrap(child(declarator, "init"));
			if (init?.type === "ObjectExpression") return init;
		}
	}
	return undefined;
}

function pluginList(object: Node): Node | undefined {
	for (const property of object.properties as Node[]) {
		if (property.type !== "ObjectProperty") continue;
		if (nameOf(child(property, "key")) !== "plugins") continue;
		const list = unwrap(child(property, "value"));
		if (list?.type === "ArrayExpression") return list;
	}
	return undefined;
}

export interface Insertion {
	at: number;
	text: string;
	/** How many characters from `at` the text replaces; none when it only inserts. */
	replaces?: number;
}

/** The width the formatter gives a line: a tab counts as its default indent width of 2. */
const LINE_WIDTH = 80;
const width = (line: string): number => line.replaceAll("\t", "  ").length;

/**
 * The one-line list with `ident` added, put one element a line when the line it sits on would
 * pass the formatter's width, as the project's formatter would; undefined when the list already
 * spans lines, holds anything besides its elements and commas, or still fits.
 */
function expandedList(
	source: string,
	list: Node,
	elements: readonly Node[],
	ident: string,
): Insertion | undefined {
	const inner = source.slice(list.start + 1, list.end - 1);
	if (inner.includes("\n")) return undefined;
	const items = elements.map((element) =>
		source.slice(element.start, element.end),
	);
	// The text around and between the elements, which must be only commas and spaces.
	const edges = [
		list.start + 1,
		...elements.flatMap((element) => [element.start, element.end]),
		list.end - 1,
	];
	let gaps = "";
	for (let index = 0; index < edges.length; index += 2)
		gaps += source.slice(edges[index], edges[index + 1]);
	if (!/^[\s,]*$/.test(gaps)) return undefined;
	const lineStart = source.lastIndexOf("\n", list.start) + 1;
	const lineEnd = source.indexOf("\n", list.end);
	const line = `${source.slice(lineStart, list.start)}[${[...items, ident].join(", ")}]${source.slice(list.end, lineEnd === -1 ? undefined : lineEnd)}`;
	if (width(line) <= LINE_WIDTH) return undefined;
	const indent = /^[ \t]*/.exec(source.slice(lineStart, list.start))?.[0] ?? "";
	return {
		at: list.start,
		replaces: list.end - list.start,
		text: `[\n${[...items, ident].map((item) => `${indent}\t${item},\n`).join("")}${indent}]`,
	};
}

/** The text to add so `ident` joins the list, in the list's own layout. */
export function listInsertion(
	source: string,
	list: Node,
	ident: string,
): Insertion {
	const elements = (list.elements as (Node | null)[]).filter(
		(element): element is Node => element !== null,
	);
	const expanded = expandedList(source, list, elements, ident);
	if (expanded) return expanded;
	const last = elements.at(-1);
	if (!last) return { at: list.start + 1, text: ident };
	const between = source.slice(last.end, list.end - 1);
	const comma = between.search(/[^\s]/);
	const trailing = between[comma] === "," ? last.end + comma + 1 : undefined;
	const multiline = source.slice(list.start, last.start).includes("\n");
	const lineStart = source.lastIndexOf("\n", last.start) + 1;
	const indent = /^[ \t]*/.exec(source.slice(lineStart, last.start))?.[0] ?? "";
	if (trailing !== undefined)
		return {
			at: trailing,
			text: multiline ? `\n${indent}${ident},` : ` ${ident},`,
		};
	return {
		at: last.end,
		text: multiline ? `,\n${indent}${ident}` : `, ${ident}`,
	};
}

/** Where the new import goes: before the first later-sorting relative import, else after the last import. */
function importInsertion(
	body: readonly Node[],
	specifier: string,
	line: string,
): Insertion {
	const imports = body.filter((node) => node.type === "ImportDeclaration");
	const later = imports.find((node) => {
		const from = (child(node, "source")?.value ?? "") as string;
		return from.startsWith(".") && from > specifier;
	});
	if (later) return { at: later.start, text: `${line}\n` };
	const last = imports.at(-1);
	return last
		? { at: last.end, text: `\n${line}` }
		: { at: 0, text: `${line}\n\n` };
}

/** Where an import of a package goes: after the package imports that sort before it, else first. */
export function packageImport(
	body: readonly Node[],
	specifier: string,
	line: string,
): Insertion {
	const imports = body.filter((node) => node.type === "ImportDeclaration");
	const from = (node: Node) => String(child(node, "source")?.value ?? "");
	const before = imports
		.filter((node) => !from(node).startsWith(".") && from(node) < specifier)
		.at(-1);
	if (before) return { at: before.end, text: `\n${line}` };
	const first = imports[0];
	return first
		? { at: first.start, text: `${line}\n` }
		: { at: 0, text: `${line}\n\n` };
}

/** Whether the module imports `name` from `specifier` under that same name. */
export function importsName(
	body: readonly Node[],
	specifier: string,
	name: string,
): boolean {
	return body.some(
		(node) =>
			node.type === "ImportDeclaration" &&
			child(node, "source")?.value === specifier &&
			(node.specifiers as Node[]).some(
				(imported) =>
					imported.type === "ImportSpecifier" &&
					nameOf(child(imported, "imported")) === name &&
					nameOf(child(imported, "local")) === name,
			),
	);
}

/** Whether the file imports anything from `specifier`. */
export const importsFrom = (
	body: readonly Node[],
	specifier: string,
): boolean =>
	body.some(
		(node) =>
			node.type === "ImportDeclaration" &&
			child(node, "source")?.value === specifier,
	);

/**
 * Adds the plugin's import line and lists it in the `plugins` array of the default export, in the
 * file's own layout; a one-line list that would pass 80 columns is put one element a line. It
 * refuses, changing nothing, a file that does not parse, a default export with no `plugins` list
 * it can find, and a name already bound.
 */
export function addPluginToConfig(
	source: string,
	plugin: { name: string; ident: string },
	file = "roundtable.config.ts",
): string {
	const body = parseModule(source, file);
	const object = exportedObject(body);
	const list = object ? pluginList(object) : undefined;
	if (!list)
		throw new ConfigEditError(
			`${file}: cannot find the plugin list. Expected \`export default { ..., plugins: [...] }\`; add \`import { ${plugin.ident} } from "./plugins/${plugin.name}.ts"\` and list ${plugin.ident} in plugins by hand.`,
		);
	const specifier = `./plugins/${plugin.name}.ts`;
	if (boundNames(body).has(plugin.ident))
		throw new ConfigEditError(
			`${file}: the name ${plugin.ident} is already used. Import the plugin by hand under another name.`,
		);
	const edits = [
		listInsertion(source, list, plugin.ident),
		importInsertion(
			body,
			specifier,
			// JSON.stringify quotes the specifier; the export script reads import lines in source text, so none may hold a placeholder.
			`import { ${plugin.ident} } from ${JSON.stringify(specifier)};`,
		),
	].sort((a, b) => b.at - a.at);
	let edited = source;
	for (const edit of edits)
		edited =
			edited.slice(0, edit.at) +
			edit.text +
			edited.slice(edit.at + (edit.replaces ?? 0));
	// A result that does not parse is a bug here; never write it.
	parseModule(edited, file);
	return edited;
}
