import type { OutfitId } from "./catalog.ts";
import type { Part, Tones } from "./colors.ts";

const WOOD = "#8b5a33";
const STEEL = "#c7cfdd";
const STEELD = "#9aa5ba";
const LEATHER = "#a6713f";

const T = "M31 94C29 79 35 71 50 71C65 71 71 79 69 94Z";
export const hand = (v: Tones, x: number, y: number, r = 4.8): string =>
	`<circle cx="${x}" cy="${y}" r="${r}" fill="${v.k}"/>`;
const torso = (fill: string): string => `<path d="${T}" fill="${fill}"/>`;
const arms = (fill: string): string =>
	`<ellipse cx="28.5" cy="80" rx="5.2" ry="8" transform="rotate(14 28.5 80)" fill="${fill}"/><ellipse cx="71.5" cy="80" rx="5.2" ry="8" transform="rotate(-14 71.5 80)" fill="${fill}"/>`;
export const star5 = (x: number, y: number, fill: string): string =>
	`<path d="M${x} ${y - 4}l1.5 3.2 3.5.4-2.6 2.4.7 3.5-3.1-1.8-3.1 1.8.7-3.5-2.6-2.4 3.5-.4z" fill="${fill}"/>`;

export const OUTFITS: Record<OutfitId, Part> = {
	robe: (v) =>
		arms(v.p) +
		torso(v.p) +
		`<path d="M30 89H70L69.6 94H30.4Z" fill="${v.t}"/><path d="M31 82.6Q50 87 69 82.6" fill="none" stroke="${WOOD}" stroke-width="2.6"/><path d="M50 83.6V92" stroke="${WOOD}" stroke-width="1.8" stroke-linecap="round"/><circle cx="50" cy="93" r="1.8" fill="${v.t}"/>` +
		star5(50, 77, v.t) +
		hand(v, 27, 88, 4.4),
	scholar: (v) =>
		arms(v.pd) +
		torso(v.pd) +
		`<path d="M39 71.5L50 85L61 71.5Z" fill="${v.s}"/><path d="M50 85V94" stroke="${v.t}" stroke-width="1.6"/><path d="M33 88H67" stroke="${v.p}" stroke-width="2.4" opacity=".7"/>`,
	armor: (v) =>
		arms(STEEL) +
		torso(STEEL) +
		`<g fill="none" stroke="${STEELD}" stroke-width=".9" stroke-linecap="round" opacity=".8"><path d="M24 79q2 1.6 4 0t4 0M23.4 84q2 1.6 4 0t4 0M68 79q2 1.6 4 0t4 0M68.6 84q2 1.6 4 0t4 0"/></g><ellipse cx="50" cy="72.6" rx="12.6" ry="3.6" fill="${STEELD}"/><path d="M37 73L63 73L66.4 94H33.6Z" fill="${v.p}"/><path d="M36 73.4L38.6 73.4L37 76ZM64 73.4L61.4 73.4L63 76Z" fill="${STEELD}"/><path d="M33.8 89H66.2L66.4 94H33.6Z" fill="${v.t}"/><path d="M34.6 83.6H65.4" stroke="${WOOD}" stroke-width="2.4"/><rect x="47" y="81.8" width="6" height="3.6" rx="1" fill="${v.t}"/><path d="M50 74.6V80M47.4 77H52.6" stroke="${v.t}" stroke-width="2.2" stroke-linecap="round"/><circle cx="31" cy="76" r="5.6" fill="${STEELD}"/><circle cx="29.6" cy="74.2" r="1.7" fill="#fff" opacity=".6"/><circle cx="69" cy="76" r="5.6" fill="${STEELD}"/><circle cx="67.6" cy="74.2" r="1.7" fill="#fff" opacity=".6"/>`,
	plate: (v) =>
		arms("#e6eaf3") +
		torso("#e6eaf3") +
		`<path d="M44 71H56L58 94H42Z" fill="${v.s}" stroke="${v.t}" stroke-width="1.6"/><path d="M50 74V92M45 81H55" stroke="${v.p}" stroke-width="3"/><circle cx="31" cy="75.5" r="6.4" fill="${v.t}"/><circle cx="69" cy="75.5" r="6.4" fill="${v.t}"/><circle cx="29.5" cy="73.5" r="2" fill="#fff" opacity=".6"/><circle cx="67.5" cy="73.5" r="2" fill="#fff" opacity=".6"/>`,
	apron: (v) =>
		arms(v.s) +
		torso(v.s) +
		`<path d="M38 71H62L66 94H34Z" fill="${LEATHER}"/><path d="M38 71L42 75M62 71L58 75" stroke="#7a4f27" stroke-width="2"/><rect x="43.5" y="82" width="13" height="8" rx="2" fill="#8d5c30"/><rect x="24" y="85" width="9" height="3" rx="1.5" fill="#8d5c30"/>`,
	chef: (v) =>
		arms("#f6f1e4") +
		torso("#f6f1e4") +
		`<path d="M33 89H67L68.2 94H31.8Z" fill="${v.s}"/><path d="M42 71.6L50 80L58 71.6" fill="none" stroke="#d6cdb4" stroke-width="1.6"/><path d="M46 74.6L50 78.4L54 74.6" fill="none" stroke="${v.p}" stroke-width="1.4"/><path d="M33 83.4Q50 88 67 83.4" fill="none" stroke="${LEATHER}" stroke-width="2.6"/><path d="M50 84.4V91.6" stroke="${LEATHER}" stroke-width="1.8" stroke-linecap="round"/><path d="M24.5 86.4h7M68.5 86.4h7" stroke="#d6cdb4" stroke-width="1.4"/>`,
	cloak: (v) =>
		`<path d="M26 79Q50 66 74 79L72 94H28Z" fill="${v.pd}"/>` +
		arms(v.p) +
		torso(v.p) +
		`<path d="M32 87H68" stroke="${WOOD}" stroke-width="3.2"/><rect x="46" y="84.8" width="8" height="4.4" rx="1.4" fill="${v.t}"/><circle cx="50" cy="72.5" r="2.6" fill="${v.t}"/>`,
	tunic: (v) =>
		arms(v.p) +
		torso(v.p) +
		`<path d="M31 83L69 76V82L31 89Z" fill="${v.s}"/><circle cx="44" cy="90" r="1.8" fill="${v.t}"/><circle cx="56" cy="88" r="1.8" fill="${v.t}"/><path d="M37 71.5q3 5 6.3 0t6.4 0t6.3 0t6.3 0V75H37Z" fill="${v.s}"/>`,
	coat: (v) =>
		arms(v.pd) +
		torso(v.pd) +
		`<path d="M50 72V94" stroke="${v.ink}" stroke-width="1" opacity=".35"/><path d="M37 71.6Q50 78 63 71.6L64 74.6Q50 81 36 74.6Z" fill="${v.s}"/><circle cx="50" cy="80.4" r="1.7" fill="${v.t}"/><circle cx="50" cy="85.8" r="1.7" fill="${v.t}"/><path d="M32 89.6Q50 93.6 68 89.6" fill="none" stroke="${v.t}" stroke-width="2"/><path d="M24.5 87.4h7M68.5 87.4h7" stroke="${v.t}" stroke-width="1.8"/>`,
	overalls: (v) =>
		arms("#efe6cf") +
		torso(v.p) +
		`<path d="M40 71.6L50 76L60 71.6V94H40Z" fill="#efe6cf"/><path d="M50 76V94" stroke="${v.pd}" stroke-width="1" opacity=".6"/><path d="M46.4 78.4h7.2M46.4 83h7.2M46.4 87.6h7.2" stroke="${v.pd}" stroke-width="1.2" stroke-linecap="round"/><path d="M31.4 89Q50 93 68.6 89V94H31.4Z" fill="${v.pd}"/><path d="M33 83.4Q50 87.6 67 83.4" fill="none" stroke="${LEATHER}" stroke-width="2.4"/><rect x="46.6" y="81.4" width="6.8" height="4.2" rx="1" fill="${v.t}"/>`,
	vest: (v) =>
		arms(v.s) +
		torso(v.p) +
		`<path d="M38 71.5L50 94H36ZM62 71.5L50 94H64Z" fill="${v.s}" opacity="0"/><path d="M50 72V94" stroke="${v.ink}" stroke-width="1" opacity=".35"/><path d="M36.6 73.6Q50 80 63.4 73.6" fill="none" stroke="${v.t}" stroke-width="1.4"/><circle cx="50" cy="80.6" r="1.6" fill="${v.t}"/><circle cx="50" cy="86.4" r="1.6" fill="${v.t}"/><path d="M38 72Q35 84 50 90Q65 84 62 72" fill="none" stroke="${v.t}" stroke-width="1.8" stroke-linecap="round"/><circle cx="50" cy="90.4" r="2.4" fill="${v.t}" stroke="${v.td}" stroke-width="1"/>`,
	habit: (v) =>
		arms(v.p) +
		`<path d="M29 94C27 78 35 71 50 71C65 71 73 78 71 94Z" fill="${v.p}"/><path d="M40 71.5L50 82L60 71.5" fill="none" stroke="${v.s}" stroke-width="3.2" stroke-linejoin="round"/><path d="M29 87H71" stroke="${v.s}" stroke-width="3"/><circle cx="50" cy="87" r="2" fill="${v.t}"/>`,
	surplice: (v) =>
		arms(v.s) +
		torso(v.s) +
		`<path d="M46 74H54V79H59V85H54V93H46V85H41V79H46Z" fill="${v.p}"/><path d="M31 90H69" stroke="${v.sd}" stroke-width="2"/>`,
	motley: (v) =>
		arms(v.p) +
		torso(v.p) +
		`<path d="M50 71C65 71 71 79 69 94H50Z" fill="${v.s}"/><path d="M71.5 72A8 8 0 0 1 71.5 88Z" fill="${v.s}" opacity="0"/><path d="M41 82L50 90L59 82L50 74Z" fill="${v.t}" opacity=".9"/><path d="M36 71.5q3 5 6.5 0t7.5 0t7.5 0t6.5 0V75H36Z" fill="${v.t}"/>`,
	sailor: (v) =>
		arms(v.s) +
		torso(v.s) +
		`<path d="M40 71.6L50 79L60 71.6" fill="none" stroke="${v.pd}" stroke-width="2.2" stroke-linejoin="round"/><path d="M45 73.6L55 73.6M46.4 76.4L53.6 76.4" stroke="${v.pd}" stroke-width="1.1" stroke-linecap="round"/><path d="M31 83.4Q50 88 69 83.4" fill="none" stroke="#d8c38c" stroke-width="3" stroke-linecap="round" stroke-dasharray="3.4 1.6"/><path d="M50 85V92" stroke="#d8c38c" stroke-width="2.2" stroke-linecap="round"/><path d="M31 89.6Q50 93.6 69 89.6V94H31Z" fill="${v.p}"/><rect x="55.6" y="75.6" width="6" height="5.4" rx="1" fill="${v.p}" opacity=".85"/>`,
};
