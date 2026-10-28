import { BUILDS, CATALOG, CLASS_IDS, type ClassId } from "./catalog.ts";
import {
	type CharacterSpec,
	type PaletteName,
	paletteOf,
	presetSpec,
} from "./spec.ts";

const NAME_WEIGHT = 3;
const PROMPT_WEIGHT = 1;
const PROMPT_CHARS = 600;
const ASCII = /^[ -~]+$/;
const MAX_SHORT = 3;

/** FNV-1a over the UTF-16 code units, an unsigned 32-bit integer. */
function fnv(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

const escapeRegExp = (text: string): string =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Matcher = (text: string) => boolean;

/** An English keyword matches from a word start (`review` finds `reviewer`); a short one is a whole word. */
function matcher(keyword: string): Matcher {
	const lower = keyword.toLowerCase();
	if (!ASCII.test(lower)) return (text) => text.includes(lower);
	const pattern = new RegExp(
		`(?<![a-z0-9])${escapeRegExp(lower)}${lower.length <= MAX_SHORT ? "(?![a-z0-9])" : ""}`,
	);
	return (text) => pattern.test(text);
}

const MATCHERS: Record<ClassId, Matcher[]> = Object.fromEntries(
	CLASS_IDS.map((id) => [id, CATALOG.classes[id].keywords.map(matcher)]),
) as Record<ClassId, Matcher[]>;

function scoreOf(id: ClassId, fields: readonly [string, number][]): number {
	let score = 0;
	for (const check of MATCHERS[id])
		for (const [text, weight] of fields) if (check(text)) score += weight;
	return score;
}

/** The index into a list of `length` that a name picks, stable across runs. */
const pick = (hash: number, length: number): number => hash % length;

/**
 * A look for an agent that has none, chosen from its role: the class whose keywords its display
 * name, name and the start of its prompt hit most, with the name's hash settling a tie or no hit
 * among the classes `taken` does not use, so two agents of one role still differ. Skin and build
 * come from the name's hash too, and the palette is the one `taken` uses least.
 */
export function suggestCharacter(
	agent: { name: string; displayName: string; prompt: string },
	taken: readonly CharacterSpec[] = [],
): CharacterSpec {
	const hash = fnv(agent.name);
	const fields: [string, number][] = [
		[agent.displayName.toLowerCase(), NAME_WEIGHT],
		[agent.name.toLowerCase(), NAME_WEIGHT],
		[agent.prompt.slice(0, PROMPT_CHARS).toLowerCase(), PROMPT_WEIGHT],
	];
	let best = 0;
	let leaders: ClassId[] = [];
	for (const id of CLASS_IDS) {
		const score = scoreOf(id, fields);
		if (score > best) {
			best = score;
			leaders = [id];
		} else if (score === best && score > 0) leaders.push(id);
	}
	const pool = best > 0 ? leaders : [...CLASS_IDS];
	const used = new Set(taken.map((spec) => spec.class));
	const free = pool.filter((id) => !used.has(id));
	const candidates = free.length > 0 ? free : pool;
	const chosen = candidates[pick(hash, candidates.length)] as ClassId;

	const spec = presetSpec(chosen);
	spec.skin = (hash % 6) as CharacterSpec["skin"];
	spec.build = BUILDS[hash % 3] as CharacterSpec["build"];

	const names = Object.keys(CATALOG.palettes) as PaletteName[];
	const count = new Map<PaletteName, number>(names.map((name) => [name, 0]));
	for (const other of taken) {
		const name = other.palette ?? paletteOf(other.colors);
		if (name) count.set(name, (count.get(name) ?? 0) + 1);
	}
	const least = Math.min(...count.values());
	const open = names.filter((name) => count.get(name) === least);
	const palette = open[pick(hash, open.length)] as PaletteName;
	spec.colors = { ...CATALOG.palettes[palette] };
	spec.palette = palette;
	return spec;
}
