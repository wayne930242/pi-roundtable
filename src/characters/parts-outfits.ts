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
		`<path d="M30 89H70L69.6 94H30.4Z" fill="${v.t}"/>` +
		star5(50, 77, v.t) +
		hand(v, 27, 88, 4.4),
	scholar: (v) =>
		arms(v.pd) +
		torso(v.pd) +
		`<path d="M39 71.5L50 85L61 71.5Z" fill="${v.s}"/><path d="M50 85V94" stroke="${v.t}" stroke-width="1.6"/><path d="M33 88H67" stroke="${v.p}" stroke-width="2.4" opacity=".7"/>`,
	armor: (v) =>
		arms(STEEL) +
		torso(STEEL) +
		`<path d="M44 71H56V94H44Z" fill="${v.p}"/><path d="M44 80H56" stroke="${v.t}" stroke-width="2"/><circle cx="31" cy="75.5" r="6.4" fill="${STEELD}"/><circle cx="69" cy="75.5" r="6.4" fill="${STEELD}"/><circle cx="29.5" cy="73.5" r="2" fill="#fff" opacity=".6"/><circle cx="67.5" cy="73.5" r="2" fill="#fff" opacity=".6"/>`,
	plate: (v) =>
		arms("#e6eaf3") +
		torso("#e6eaf3") +
		`<path d="M44 71H56L58 94H42Z" fill="${v.s}" stroke="${v.t}" stroke-width="1.6"/><path d="M50 74V92M45 81H55" stroke="${v.p}" stroke-width="3"/><circle cx="31" cy="75.5" r="6.4" fill="${v.t}"/><circle cx="69" cy="75.5" r="6.4" fill="${v.t}"/><circle cx="29.5" cy="73.5" r="2" fill="#fff" opacity=".6"/><circle cx="67.5" cy="73.5" r="2" fill="#fff" opacity=".6"/>`,
	apron: (v) =>
		arms(v.s) +
		torso(v.s) +
		`<path d="M38 71H62L66 94H34Z" fill="${LEATHER}"/><path d="M38 71L42 75M62 71L58 75" stroke="#7a4f27" stroke-width="2"/><rect x="43.5" y="82" width="13" height="8" rx="2" fill="#8d5c30"/><rect x="24" y="85" width="9" height="3" rx="1.5" fill="#8d5c30"/>`,
	chef: (v) =>
		arms("#fff") +
		torso("#fff") +
		`<path d="M50 72V94" stroke="#cfd5e4" stroke-width="1.4"/><circle cx="45" cy="79" r="1.7" fill="${v.t}"/><circle cx="45" cy="87" r="1.7" fill="${v.t}"/><circle cx="55" cy="79" r="1.7" fill="${v.t}"/><circle cx="55" cy="87" r="1.7" fill="${v.t}"/><path d="M41 71.5Q50 77 59 71.5L57 75Q50 79 43 75Z" fill="${v.p}"/>`,
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
		`<path d="M50 72V94" stroke="${v.ink}" stroke-width="1" opacity=".35"/><path d="M40 71.5L47 84L50 72ZM60 71.5L53 84L50 72Z" fill="${v.s}"/><circle cx="46" cy="87" r="1.8" fill="${v.t}"/><circle cx="54" cy="87" r="1.8" fill="${v.t}"/><circle cx="46" cy="80" r="1.8" fill="${v.t}" opacity="0"/>`,
	overalls: (v) =>
		arms(v.s) +
		torso(v.s) +
		`<path d="M36 80H64V94H36Z" fill="${v.p}"/><path d="M39 80L40 71.4M61 80L60 71.4" stroke="${v.p}" stroke-width="4"/><rect x="44.5" y="83" width="11" height="6" rx="1.5" fill="${v.pd}"/><circle cx="40" cy="79" r="1.6" fill="${v.t}"/><circle cx="60" cy="79" r="1.6" fill="${v.t}"/>`,
	vest: (v) =>
		arms(v.s) +
		torso(v.s) +
		`<path d="M37 71.5L45 94H36ZM63 71.5L55 94H64Z" fill="${v.p}"/><path d="M40 83Q50 90 60 83" fill="none" stroke="${v.t}" stroke-width="1.6"/><circle cx="50" cy="86" r="2" fill="${v.t}"/>`,
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
		`<path d="M31 78H69M31 84H69M31 90H69" stroke="${v.p}" stroke-width="2.6"/><path d="M38 71.5L50 82L62 71.5L56 71Q50 76 44 71Z" fill="${v.pd}"/>`,
};
