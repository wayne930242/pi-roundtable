import {
	boundNames,
	ConfigEditError,
	child,
	exportedObject,
	importsFrom,
	importsName,
	listInsertion,
	type Node,
	nameOf,
	packageImport,
	parseConfig,
	unwrap,
} from "./config-edit.ts";
import { CONFIG_FILE } from "./project.ts";
import { Rewrite } from "./upgrade-rewrite.ts";

/** A configuration rewritten in the 0.9 form: the new text, what changed, and what to look over. */
export interface Upgraded {
	source: string;
	/** One line per rewrite made; none when the configuration is already in the 0.9 form. */
	changes: string[];
	/** What the rewrite did that a person should look at, such as comments it moved. */
	notes: string[];
}

const DISCORD_ENTRY = "pi-roundtable/discord";
const TAB = "\t";
/** The width the formatter gives a line: a tab counts as its default indent width of 2. */
const LINE_WIDTH = 80;
const width = (line: string): number => line.replaceAll("\t", "  ").length;
/** Expressions a method can be called on as they are written, without parentheses. */
const CALLABLE = new Set([
	"Identifier",
	"MemberExpression",
	"OptionalMemberExpression",
	"CallExpression",
	"OptionalCallExpression",
	"ArrayExpression",
]);

/** The properties of an object literal by name, refusing a spread or a key it cannot name. */
function propertiesOf(
	rewrite: Rewrite,
	object: Node,
	path: string,
	known: readonly string[],
): Map<string, Node> {
	const found = new Map<string, Node>();
	for (const property of object.properties as Node[]) {
		if (property.type !== "ObjectProperty" || property.computed === true)
			throw rewrite.at(
				property,
				`${path} has a key the upgrade cannot read; write it as plain keys (${known.join(", ")}), or rewrite it by hand`,
			);
		const key = nameOf(child(property, "key")) ?? "";
		if (!known.includes(key))
			throw rewrite.at(
				property,
				`${path}.${key} is not a key of ${path} (${known.join(", ")}); remove it, or rewrite it by hand`,
			);
		found.set(key, property);
	}
	return found;
}

/** The property's value as an object literal, or a ConfigEditError saying it is not one. */
function objectValue(rewrite: Rewrite, property: Node, path: string): Node {
	const value = unwrap(child(property, "value"));
	if (property.shorthand === true || value?.type !== "ObjectExpression")
		throw rewrite.at(
			property,
			`${path} is not an object written here, so the upgrade cannot read it; write it out as { ... } in this file, or rewrite it as access by hand`,
		);
	return value;
}

/** An identity of a Discord id: a string for a string, a template around anything else. */
function prefixed(rewrite: Rewrite, prefix: string, node: Node): string {
	if (node.type === "StringLiteral")
		return JSON.stringify(`${prefix}${String(node.value)}`);
	return `\`${prefix}\${${rewrite.text(node)}}\``;
}

/** A list of Discord ids as identities or roles, item by item, or mapped when it is built elsewhere. */
function prefixedList(
	rewrite: Rewrite,
	prefix: string,
	value: Node,
	path: string,
	variable: string,
): string[] | string {
	const list = unwrap(value);
	if (list?.type !== "ArrayExpression") {
		const text = rewrite.text(value);
		const callee = CALLABLE.has(value.type) ? text : `(${text})`;
		return `${callee}.map((${variable}) => \`${prefix}\${${variable}}\`)`;
	}
	return (list.elements as (Node | null)[]).map((element, i) => {
		if (element === null || element.type === "SpreadElement")
			throw rewrite.at(
				element ?? list,
				`${path}[${i}] is spread from another list, which the upgrade cannot read; list the ids here, or rewrite it by hand`,
			);
		return prefixed(rewrite, prefix, element);
	});
}

/** A list as the formatter prints it: on its line when it fits, else one item a line. */
function listText(
	items: readonly string[],
	indent: string,
	lead: string,
): string {
	const line = `[${items.join(", ")}]`;
	if (width(`${indent}${lead}${line},`) <= LINE_WIDTH) return line;
	return `[\n${items.map((item) => `${indent}${TAB}${item},\n`).join("")}${indent}]`;
}

type Field = [key: string, value: string[] | string];

function objectText(fields: readonly Field[], indent: string): string {
	const inner = `${indent}${TAB}`;
	const lines = fields.map(([key, value]) => {
		const lead = `${key}: `;
		const text =
			typeof value === "string" ? value : listText(value, inner, lead);
		return `${inner}${lead}${text},\n`;
	});
	return `{\n${lines.join("")}${indent}}`;
}

/**
 * 0.8's `everyone`, which reached Discord alone, as everyone on Discord. An expression is the
 * condition of a new conditional, in parentheses unless it is one operand already, so a
 * conditional or `||` written there keeps its meaning.
 */
function everyoneText(rewrite: Rewrite, value: Node): string {
	if (value.type !== "BooleanLiteral") {
		const text = rewrite.text(value);
		const condition = CALLABLE.has(value.type) ? text : `(${text})`;
		return `${condition} ? ["discord"] : false`;
	}
	return value.value === true ? '["discord"]' : "false";
}

/** One 0.8 tier, `{ users, roles, everyone }`, as an access tier. */
function tierFields(rewrite: Rewrite, property: Node, path: string): Field[] {
	const tier = propertiesOf(
		rewrite,
		objectValue(rewrite, property, path),
		path,
		["users", "roles", "everyone"],
	);
	const fields: Field[] = [];
	const users = tier.get("users");
	if (users)
		fields.push([
			"identities",
			prefixedList(
				rewrite,
				"discord:",
				child(users, "value") as Node,
				`${path}.users`,
				"id",
			),
		]);
	const roles = tier.get("roles");
	if (roles)
		fields.push([
			"roles",
			prefixedList(
				rewrite,
				"discord:role:",
				child(roles, "value") as Node,
				`${path}.roles`,
				"role",
			),
		]);
	const everyone = tier.get("everyone");
	if (everyone) {
		const value = child(everyone, "value") as Node;
		fields.push(["everyone", everyoneText(rewrite, value)]);
	}
	return fields;
}

/** The `access` text that means what `owner` and `speakers` meant in 0.8. */
function accessText(
	rewrite: Rewrite,
	owner: Node,
	speakers: Node | undefined,
	withDiscord: boolean,
	indent = "",
): string {
	const fields = propertiesOf(
		rewrite,
		objectValue(rewrite, owner, "owner"),
		"owner",
		["id", "name", "pronouns"],
	);
	const fieldValue = (key: string): Node | undefined => {
		const property = fields.get(key);
		return property && (child(property, "value") as Node);
	};
	const id = fieldValue("id");
	const name = fieldValue("name");
	if (!id || !name)
		throw rewrite.at(
			owner,
			"owner needs an id and a name; add the missing one, or write access by hand",
		);
	const pronouns = fieldValue("pronouns");
	const ownerFields: Field[] = [
		["name", rewrite.text(name)],
		...(pronouns ? [["pronouns", rewrite.text(pronouns)] as Field] : []),
		["principal", rewrite.text(id)],
		...(withDiscord
			? [["identities", [prefixed(rewrite, "discord:", id)]] as Field]
			: []),
	];
	const tiers: Field[] = [];
	if (speakers) {
		const map = propertiesOf(
			rewrite,
			objectValue(rewrite, speakers, "speakers"),
			"speakers",
			["admins", "members"],
		);
		const inner = `${indent}${TAB}`;
		for (const tier of ["admins", "members"]) {
			const property = map.get(tier);
			if (property)
				tiers.push([
					tier,
					objectText(tierFields(rewrite, property, `speakers.${tier}`), inner),
				]);
		}
	}
	const inner = `${indent}${TAB}`;
	const owners = `[\n${inner}${TAB}${objectText(ownerFields, `${inner}${TAB}`)},\n${inner}]`;
	return `access: ${objectText([["owners", owners], ...tiers], indent)}`;
}

/** The value's text with each line after the first indented one tab more, unless a template literal spans lines. */
function indented(text: string): string {
	if (/`[^`]*\n[^`]*`/.test(text)) return text;
	return text.replaceAll(/\n(?=[^\n])/g, `\n${TAB}`);
}

/**
 * The configuration in the 0.9 form: `owner` and `speakers` as the `access` they mean (the owner's
 * principal their old id, their identity `discord:<id>` on a host with Discord, roles `discord:role:<id>`, `everyone`
 * as everyone on Discord), and the top-level `discord` as `adapters: [discord({...})]` with its
 * import. It keeps every comment, and notes the ones it moved. A configuration already in the
 * 0.9 form comes back as it is. Throws a ConfigEditError, changing nothing, for what it cannot
 * rewrite with confidence.
 */
export function upgradeSource(source: string, file = CONFIG_FILE): Upgraded {
	const { body, comments } = parseConfig(
		source,
		file,
		"rewrite owner and speakers as access by hand",
	);
	const object = exportedObject(body);
	if (!object)
		throw new ConfigEditError(
			`${file}: cannot find the configuration object. Expected \`export default { ... }\`, or a constant of this file it names; rewrite owner and speakers as access by hand.`,
		);
	const rewrite = new Rewrite(source, file, comments);
	const named = new Map<string, Node>();
	let spread: Node | undefined;
	for (const property of object.properties as Node[]) {
		if (property.type === "SpreadElement") spread ??= property;
		const key =
			property.computed === true ? undefined : nameOf(child(property, "key"));
		if (key) named.set(key, property);
	}
	const owner = named.get("owner");
	const speakers = named.get("speakers");
	const discord = named.get("discord");
	if (!owner && !speakers && !discord)
		return { source, changes: [], notes: [] };
	if (spread)
		throw rewrite.at(
			spread,
			"the configuration spreads another object, which may hold owner, speakers, or access; write the keys in this object, or rewrite them by hand",
		);
	const access = named.get("access");
	if (access && (owner || speakers))
		throw rewrite.at(
			owner ?? access,
			"the configuration writes access beside owner and speakers; write the owners in one of them, not both. Remove owner and speakers if access says the same.",
		);
	if (speakers && !owner)
		throw rewrite.at(
			speakers,
			"speakers without owner: 0.8 needed both; add the owner, or write access by hand",
		);

	const changes: string[] = [];
	if (owner) {
		const indent = rewrite.indentOf(owner);
		const spans = [{ start: owner.start, end: owner.end }];
		if (speakers) {
			const removal = rewrite.removal(speakers);
			spans.push(removal);
			rewrite.edits.push({ ...removal, text: "" });
		}
		const comments = spans.flatMap((span) =>
			rewrite.commentsIn(span.start, span.end),
		);
		rewrite.moved.push(...comments);
		// The host gives the 0.8 owner a Discord identity only with Discord configured.
		const withDiscord = Boolean(discord) || importsFrom(body, DISCORD_ENTRY);
		const text = accessText(rewrite, owner, speakers, withDiscord, indent);
		rewrite.edits.push({
			start: owner.start,
			end: owner.end,
			text: `${rewrite.commentLines(comments, indent)}${text}`,
		});
		const ownerChange = withDiscord
			? "the owner's principal is their old id and their identity discord:<id>"
			: "the owner's principal is their old id, with no identity, as a host without Discord has none";
		changes.push(
			speakers
				? `owner and speakers → access: ${ownerChange}; users are discord:<id>, roles discord:role:<id>, and everyone means everyone on Discord`
				: `owner → access: ${ownerChange}`,
		);
	}
	if (discord) {
		const value = child(discord, "value") as Node;
		const bound = boundNames(body);
		const imported = importsName(body, DISCORD_ENTRY, "discord");
		if (bound.has("discord") && !imported)
			throw rewrite.at(
				discord,
				`the name discord is already used in this file; rename it, or write adapters: [discord({ ... })] with discord from ${DISCORD_ENTRY} by hand`,
			);
		const indent = rewrite.indentOf(discord);
		const between = [
			...rewrite.commentsIn(discord.start, value.start),
			...rewrite.commentsIn(value.end, discord.end),
		];
		const call = `discord(${indent === undefined ? rewrite.text(value) : indented(rewrite.text(value))})`;
		const adapters = named.get("adapters");
		if (adapters) {
			const list = unwrap(child(adapters, "value"));
			if (list?.type !== "ArrayExpression")
				throw rewrite.at(
					adapters,
					"adapters is not a list written here, so the upgrade cannot add Discord to it; add discord({ ... }) to it by hand",
				);
			const removal = rewrite.removal(discord);
			// Those inside the settings go with them into discord(...); the rest lead the list.
			const comments = rewrite
				.commentsIn(removal.start, removal.end)
				.filter(
					(comment) => comment.end <= value.start || comment.start >= value.end,
				);
			rewrite.moved.push(...comments);
			rewrite.edits.push({ ...removal, text: "" });
			if (comments.length > 0)
				rewrite.edits.push({
					start: adapters.start,
					end: adapters.start,
					text: rewrite.commentLines(comments, rewrite.indentOf(adapters)),
				});
			const added = listInsertion(rewrite.source, list, call);
			rewrite.edits.push({
				start: added.at,
				end: added.at + (added.replaces ?? 0),
				text: added.text,
			});
		} else {
			rewrite.moved.push(...between);
			const text =
				indent === undefined
					? `adapters: [${call}]`
					: `adapters: [\n${indent}${TAB}${call},\n${indent}]`;
			rewrite.edits.push({
				start: discord.start,
				end: discord.end,
				text: `${rewrite.commentLines(between, indent)}${text}`,
			});
		}
		if (!imported) {
			const added = packageImport(
				body,
				DISCORD_ENTRY,
				`import { discord } from "${DISCORD_ENTRY}";`,
			);
			rewrite.edits.push({ start: added.at, end: added.at, text: added.text });
		}
		changes.push(
			`discord → adapters: [discord({ ... })], with discord imported from ${DISCORD_ENTRY}`,
		);
	}

	const edits = rewrite.edits.toSorted((a, b) => b.start - a.start);
	edits.forEach((edit, i) => {
		const later = edits[i - 1];
		if (later && edit.end > later.start)
			throw new ConfigEditError(
				`${file}: the keys the upgrade rewrites overlap; rewrite owner, speakers, and discord by hand.`,
			);
	});
	let upgraded = source;
	for (const edit of edits)
		upgraded =
			upgraded.slice(0, edit.start) + edit.text + upgraded.slice(edit.end);
	// A result that does not parse is a bug here; never hand it back.
	parseConfig(upgraded, file, "report this as a bug in roundtable upgrade");
	const notes =
		rewrite.moved.length === 0
			? []
			: [
					`moved ${rewrite.moved.length} ${rewrite.moved.length === 1 ? "comment" : "comments"} from the rewritten keys to above the key that now holds what they were about; check they still read right`,
				];
	return { source: upgraded, changes, notes };
}
