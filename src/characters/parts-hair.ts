import type { AccessoryId, BeardId, HairId } from "./catalog.ts";
import type { Part, Tones } from "./colors.ts";

/** Hair is two layers: behind the head, and the fringe over the forehead. */
export interface HairLayers {
	back: string;
	front: string;
}

const FRINGE = "M24 47C23 29 77 29 76 47C70 39 61 35 50 35C39 35 30 39 24 47Z";
export const HAIR: Record<HairId, (v: Tones) => HairLayers> = {
	none: () => ({ back: "", front: "" }),
	short: (v) => ({ back: "", front: `<path d="${FRINGE}" fill="${v.hr}"/>` }),
	bob: (v) => ({
		back: `<path d="M19 46C17 66 23 77 33 77H67C77 77 83 66 81 46C78 26 22 26 19 46Z" fill="${v.hr}"/>`,
		front: `<path d="M23 50C22 28 78 28 77 50C68 38 58 36 50 41C42 36 32 38 23 50Z" fill="${v.hr}"/>`,
	}),
	long: (v) => ({
		back: `<path d="M18 48C14 72 20 92 34 92H66C80 92 86 72 82 48C80 26 20 26 18 48Z" fill="${v.hr}"/>`,
		front: `<path d="M23 52C22 28 78 28 77 52C70 38 62 36 56 38Q44 44 36 46Q28 48 23 52Z" fill="${v.hr}"/>`,
	}),
	bun: (v) => ({
		back: `<circle cx="50" cy="21" r="9.5" fill="${v.hr}"/>`,
		front: `<path d="${FRINGE}" fill="${v.hr}"/>`,
	}),
	curly: (v) => ({
		back: "",
		front: `<g fill="${v.hr}"><circle cx="30" cy="38" r="9"/><circle cx="41" cy="30" r="9.5"/><circle cx="55" cy="29" r="9.5"/><circle cx="68" cy="35" r="9"/><circle cx="23" cy="50" r="6"/><circle cx="77" cy="50" r="6"/></g>`,
	}),
	ponytail: (v) => ({
		back: `<path d="M70 40C92 42 94 66 82 76C86 62 80 54 68 52Z" fill="${v.hr}"/>`,
		front: `<path d="${FRINGE}" fill="${v.hr}"/>`,
	}),
	braid: (v) => ({
		back: `<path d="M24 46C14 60 20 76 28 90L34 88C28 76 28 62 32 52Z" fill="${v.hr}"/><circle cx="28" cy="90" r="3.6" fill="${v.p}"/>`,
		front: `<path d="${FRINGE}" fill="${v.hr}"/>`,
	}),
};

export const BEARDS: Record<BeardId, Part> = {
	full: (v) =>
		`<path d="M23.4 47C22 59 36 59 50 59.4C64 59 78 59 76.6 47C81 66 66 88 50 91.5C34 88 19 66 23.4 47Z" fill="${v.hr}"/><path d="M50 62V88" stroke="${v.hd}" stroke-width="1.2" opacity=".5"/><path d="M36 60Q50 66 64 60" fill="none" stroke="${v.hd}" stroke-width="1.2" opacity=".5"/>`,
	mustache: (v) =>
		`<path d="M38 60C42 54 48 58 50 60C52 58 58 54 62 60C58 62 53 60 50 61.4C47 60 42 62 38 60Z" fill="${v.hr}"/>`,
	goatee: (v) =>
		`<path d="M44 68C46 66 54 66 56 68C56 76 52 78 50 78C48 78 44 76 44 68Z" fill="${v.hr}"/>`,
};

export const ACCESSORIES: Record<AccessoryId, Part> = {
	glasses: (v) =>
		`<g fill="none" stroke="${v.ink}" stroke-width="1.7"><circle cx="39" cy="52" r="8.4"/><circle cx="61" cy="52" r="8.4"/><path d="M47.4 51Q50 49 52.6 51M30.6 50L25 47M69.4 50L75 47"/></g><path d="M33 47L37 45M56 47L60 45" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".7"/>`,
	freckles: (v) =>
		`<g fill="${v.kd}"><circle cx="32.5" cy="60" r="1"/><circle cx="36" cy="62" r="1"/><circle cx="39.5" cy="60.4" r="1"/><circle cx="60.5" cy="60.4" r="1"/><circle cx="64" cy="62" r="1"/><circle cx="67.5" cy="60" r="1"/></g>`,
	scar: (v) =>
		`<path d="M64 44L70 57M62.4 51H67M65 47.6H69" stroke="${v.kd}" stroke-width="1.5" stroke-linecap="round" opacity=".85"/><path d="M64 44L70 57" stroke="#e9a0a0" stroke-width=".8" opacity=".7"/>`,
};
