import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where a change waits for its release: one file per branch, so two branches never edit the same lines. */
export const FRAGMENT_DIR = "changes/unreleased";

/** The sections a changelog entry belongs to, in the order Keep a Changelog lists them. */
export const TYPES = [
	"Added",
	"Changed",
	"Deprecated",
	"Removed",
	"Fixed",
	"Security",
] as const;
export type FragmentType = (typeof TYPES)[number] | "none";

/** The root package's name in a fragment's `packages` list; every other entry is a directory under `packages/`. */
export const CORE = "core";

export class FragmentError extends Error {
	override name = "FragmentError";
}

export interface Fragment {
	/** The path relative to the repository root. */
	file: string;
	type: FragmentType;
	/** `core`, or workspace directories. Empty for `type: none`. */
	packages: string[];
	/** Whether the root changelog also gets the entries of a workspace-only fragment. */
	root: boolean;
	/** One entry per paragraph of the body, without the leading dash. */
	bullets: string[];
}

/** A changelog's entries for one release: bullets under a `###` section, and bullets that sit under none. */
export interface Entries {
	groups: Map<string, string[]>;
	plain: string[];
}

export const emptyEntries = (): Entries => ({ groups: new Map(), plain: [] });

const isEmpty = (entries: Entries): boolean =>
	entries.plain.length === 0 &&
	[...entries.groups.values()].every((bullets) => bullets.length === 0);

function frontMatter(
	file: string,
	text: string,
): [Map<string, string>, string] {
	const lines = text.split("\n");
	if (lines[0] !== "---")
		throw new FragmentError(`${file}: starts with --- front matter`);
	const close = lines.indexOf("---", 1);
	if (close < 0) throw new FragmentError(`${file}: front matter is not closed`);
	const fields = new Map<string, string>();
	for (const line of lines.slice(1, close)) {
		const found = /^([a-z]+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
		if (!found) throw new FragmentError(`${file}: cannot read "${line}"`);
		fields.set(found[1] ?? "", found[2] ?? "");
	}
	return [fields, lines.slice(close + 1).join("\n")];
}

/** The paragraphs of a fragment's body, each one changelog entry. */
function paragraphs(text: string): string[] {
	return text
		.split(/\n\s*\n/)
		.map((paragraph) =>
			paragraph
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.join(" ")
				.replace(/^- /, ""),
		)
		.filter(Boolean);
}

/** Reads one fragment; `workspaces` are the directories under `packages/` its `packages` may name. */
export function parseFragment(
	file: string,
	text: string,
	workspaces: readonly string[],
): Fragment {
	const [fields, body] = frontMatter(file, text);
	for (const key of fields.keys())
		if (!["type", "packages", "root"].includes(key))
			throw new FragmentError(`${file}: unknown front matter field ${key}`);
	const type = fields.get("type");
	if (type !== "none" && !TYPES.includes(type as (typeof TYPES)[number]))
		throw new FragmentError(
			`${file}: type must be one of ${[...TYPES, "none"].join(", ")}`,
		);
	const list = /^\[(.*)\]$/.exec(fields.get("packages") ?? "");
	const packages = (list?.[1] ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	if (type !== "none" && packages.length === 0)
		throw new FragmentError(`${file}: packages is a list such as [core, web]`);
	for (const name of packages)
		if (name !== CORE && !workspaces.includes(name))
			throw new FragmentError(
				`${file}: unknown package ${name} (core, ${workspaces.join(", ")})`,
			);
	const root = fields.get("root");
	if (root !== undefined && root !== "true" && root !== "false")
		throw new FragmentError(`${file}: root is true or false`);
	const bullets = paragraphs(body);
	if (bullets.length === 0) throw new FragmentError(`${file}: has no text`);
	return {
		file,
		type: type as FragmentType,
		packages,
		root: root !== "false",
		bullets,
	};
}

/** Every fragment under `changes/unreleased`, in file name order so the assembled text does not depend on the file system. */
export function loadFragments(
	root: string,
	workspaces: readonly string[],
): Fragment[] {
	const dir = join(root, FRAGMENT_DIR);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.sort()
		.map((name) =>
			parseFragment(
				`${FRAGMENT_DIR}/${name}`,
				readFileSync(join(dir, name), "utf8"),
				workspaces,
			),
		);
}

/** The text of a changelog's `## [Unreleased]` section, or undefined when it has no such heading. */
function unreleasedLines(text: string): [number, number] | undefined {
	const lines = text.split("\n");
	const at = lines.indexOf("## [Unreleased]");
	if (at < 0) return undefined;
	const next = lines.findIndex((line, i) => i > at && line.startsWith("## ["));
	return [at, next < 0 ? lines.length : next];
}

/** The entries already written by hand under a changelog's `## [Unreleased]`. */
export function parseUnreleased(text: string): Entries {
	const span = unreleasedLines(text);
	const entries = emptyEntries();
	if (!span) return entries;
	let target = entries.plain;
	let last: string[] | undefined;
	for (const line of text.split("\n").slice(span[0] + 1, span[1])) {
		const heading = /^### (.+)$/.exec(line);
		if (heading) {
			const name = heading[1] ?? "";
			target = entries.groups.get(name) ?? [];
			entries.groups.set(name, target);
			last = undefined;
		} else if (line.startsWith("- ")) {
			target.push(line.slice(2));
			last = target;
		} else if (line.trim() && last) {
			last[last.length - 1] += `\n${line}`;
		}
	}
	return entries;
}

const add = (entries: Entries, type: string, bullet: string): void => {
	const bullets = entries.groups.get(type) ?? [];
	bullets.push(bullet);
	entries.groups.set(type, bullets);
};

/** The entry the root changelog gets for a workspace's change, led by the package it concerns. */
function rolledUp(dirs: readonly string[], bullet: string): string {
	const label = dirs.map((dir) => `pi-roundtable-${dir}`).join(", ");
	const own = /^pi-roundtable-[a-z][a-z0-9-]*: /.exec(bullet);
	return `${label}: ${own ? bullet.slice(own[0].length) : bullet}`;
}

/**
 * The entries each changelog gets, keyed by `core` or workspace directory: the fragments' bullets
 * after what the changelog already holds under Unreleased. A fragment for workspaces only also
 * reaches the root changelog, led by the package names, unless it sets `root: false`.
 */
export function distribute(
	fragments: readonly Fragment[],
	unreleased: ReadonlyMap<string, Entries>,
): Map<string, Entries> {
	const result = new Map<string, Entries>();
	for (const [target, entries] of unreleased)
		result.set(target, {
			groups: new Map(
				[...entries.groups].map(([type, bullets]) => [type, [...bullets]]),
			),
			plain: [...entries.plain],
		});
	const entriesOf = (target: string): Entries => {
		const found = result.get(target) ?? emptyEntries();
		result.set(target, found);
		return found;
	};
	for (const fragment of fragments) {
		if (fragment.type === "none") continue;
		for (const bullet of fragment.bullets) {
			for (const target of fragment.packages)
				add(entriesOf(target), fragment.type, bullet);
			if (fragment.root && !fragment.packages.includes(CORE))
				add(
					entriesOf(CORE),
					fragment.type,
					rolledUp(fragment.packages, bullet),
				);
		}
	}
	return result;
}

/** The lockstep line a changelog gets when the release brought it no entry of its own. */
export function lockstepLine(version: string, summary?: string): string {
	return `Release in lockstep with pi-roundtable ${version}${summary ? ` (${summary})` : ""}; no package-specific behavior changes.`;
}

/** The release's body for one changelog: bullets under their `###` sections in the changelog order, or the lockstep line. */
export function renderEntries(entries: Entries, lockstep: string): string {
	if (isEmpty(entries)) return `- ${lockstep}`;
	const known: string[] = [...TYPES];
	const types = [
		...known.filter((type) => entries.groups.has(type)),
		...[...entries.groups.keys()].filter((type) => !known.includes(type)),
	];
	const bullets = (list: string[]) => list.map((text) => `- ${text}`);
	return [
		...(entries.plain.length > 0 ? bullets(entries.plain) : []),
		...types.flatMap((type) => {
			const list = entries.groups.get(type) ?? [];
			return list.length > 0 ? ["", `### ${type}`, "", ...bullets(list)] : [];
		}),
	]
		.join("\n")
		.replace(/^\n+/, "");
}

/** The changelog with its Unreleased section emptied and the release's section below it. */
export function insertRelease(
	text: string,
	version: string,
	date: string,
	body: string,
): string {
	const span = unreleasedLines(text);
	if (!span)
		throw new FragmentError("changelog has no ## [Unreleased] heading");
	if (text.split("\n").some((line) => line.startsWith(`## [${version}]`)))
		throw new FragmentError(`changelog already has a ## [${version}] section`);
	const lines = text.split("\n");
	const after = lines.slice(span[1]);
	return [
		...lines.slice(0, span[0] + 1),
		"",
		`## [${version}] - ${date}`,
		"",
		...body.split("\n"),
		"",
		...(after.length > 0 ? after : [""]),
	].join("\n");
}
