import { CATALOG, type ClassId } from "pi-roundtable/characters";
import { translate } from "./messages.ts";

/** The kinds of thing the creator names. */
export type LabelKind =
	| "class"
	| "palette"
	| "outfit"
	| "hat"
	| "prop"
	| "hair"
	| "beard"
	| "accessory"
	| "build";

// English for the ids whose name is not just the id with a capital.
const ENGLISH: Readonly<Record<string, string>> = {
	"hat.none": "No hat",
	"hat.goggcap": "Leather cap",
	"hat.tallcap": "Tall hat",
	"hat.softcap": "Soft cap",
	"hat.hardhat": "Iron skullcap",
	"hat.fcap": "Hunter's cap",
	"hat.winghelm": "Winged helm",
	"hat.helm": "Helm",
	"hat.mortar": "Biretta",
	"hat.beret": "Chaperon",
	"hat.goggles": "Pointed cap",
	"hat.tricorn": "Pilgrim hat",
	"hat.sailor": "Straw hat",
	"hat.kettle": "Kettle hat",
	"hat.cavalier": "Feathered hat",
	"hat.toque": "Cook's cap",
	"hair.none": "No hair",
	"beard.none": "No beard",
	"accessory.none": "No accessory",
	"prop.beads": "Prayer beads",
	"prop.marotte": "Marotte",
	"prop.map": "Chart",
	"prop.flask": "Alchemist's phial",
	"prop.telescope": "Astrolabe",
	"prop.wrench": "Dividers",
	"outfit.surplice": "Surplice",
	"outfit.overalls": "Work jerkin",
	"outfit.armor": "Mail hauberk",
	"outfit.apron": "Smith's apron",
	"outfit.chef": "Cook's tunic",
	"outfit.coat": "Doublet",
	"outfit.vest": "Pourpoint",
	"outfit.sailor": "Mariner's tunic",
	"hair.bob": "Bob",
	"hair.bun": "Bun",
	"hair.ponytail": "Ponytail",
};

const capital = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/**
 * The name of a class, palette or part. A host can word it in its message dictionary under
 * `character.<kind>.<id>`; without an entry the English name shows.
 */
export function characterLabel(kind: LabelKind, id: string): string {
	const key = `character.${kind}.${id}`;
	const wording = translate(key);
	if (wording !== key) return wording;
	if (kind === "class")
		return CATALOG.classes[id as ClassId]?.label ?? capital(id);
	return ENGLISH[`${kind}.${id}`] ?? capital(id);
}

/** What a class is for, in English, or the host's wording under `character.jobs.<id>`. */
export function characterJobs(id: ClassId): string {
	const key = `character.jobs.${id}`;
	const wording = translate(key);
	return wording !== key ? wording : (CATALOG.classes[id]?.jobs ?? "");
}
