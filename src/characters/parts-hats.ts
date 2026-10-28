import type { HatId } from "./catalog.ts";
import type { Part } from "./colors.ts";
import { star5 } from "./parts-outfits.ts";

const STEEL = "#c7cfdd";
const STEELD = "#9aa5ba";

export const HATS: Record<HatId, Part> = {
	none: () => "",
	wizard: (v) =>
		`<path d="M30 31C32 20 42 11 60 3C57 13 62 22 70 31Z" fill="${v.p}"/><path d="M30 31C32 20 42 11 60 3" fill="none" stroke="#fff" stroke-width="1.6" opacity=".35"/><ellipse cx="50" cy="30" rx="37" ry="7.6" fill="${v.pd}"/><path d="M30.6 27.6Q50 33 69.4 27.6L70 31Q50 36.5 30 31Z" fill="${v.t}"/>` +
		star5(49, 16, v.t),
	helm: (v) =>
		`<path d="M50 24C42 6 66 -1 80 12C68 9 60 15 57 25Z" fill="${v.p}"/><path d="M23 47C21 23 79 23 77 47L72 39Q50 31 28 39Z" fill="${STEEL}"/><path d="M26 36Q50 24 74 36" fill="none" stroke="#fff" stroke-width="2" opacity=".55"/><path d="M28 39Q50 31 72 39" fill="none" stroke="${v.t}" stroke-width="3"/><circle cx="50" cy="26.5" r="3.4" fill="${v.t}"/>`,
	mortar: (v) =>
		`<path d="M30 29V37Q50 43 70 37V29Z" fill="${v.pd}"/><path d="M13 24L50 12L87 24L50 36Z" fill="${v.p}"/><path d="M13 24L50 36L87 24" fill="none" stroke="${v.pd}" stroke-width="1.6"/><path d="M50 24L82 26V38" fill="none" stroke="${v.t}" stroke-width="1.8" stroke-linejoin="round"/><rect x="79.6" y="37" width="4.8" height="7" rx="2" fill="${v.t}"/><circle cx="50" cy="24" r="2.4" fill="${v.t}"/>`,
	goggcap: (v) =>
		`<path d="M23 41C23 21 77 21 77 41Q50 33 23 41Z" fill="${v.p}"/><path d="M54 36Q78 32 85 41Q70 43 51 40Z" fill="${v.pd}"/><path d="M23 37Q50 28 77 37V40Q50 31 23 40Z" fill="${v.pd}"/><circle cx="40" cy="27.5" r="7" fill="#bfeaf6" stroke="${v.t}" stroke-width="2.6"/><circle cx="60" cy="27.5" r="7" fill="#bfeaf6" stroke="${v.t}" stroke-width="2.6"/><path d="M36.5 25Q39 23 42 24.5M56.5 25Q59 23 62 24.5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`,
	hood: (v) =>
		`<path d="M21 53C20 26 80 26 79 53C76 40 66 33.5 50 33.5C34 33.5 24 40 21 53Z" fill="${v.p}"/><path d="M21 53C20 26 80 26 79 53" fill="none" stroke="${v.pd}" stroke-width="2"/><path d="M70 33Q90 24 93 8Q76 12 66 30Z" fill="${v.t}"/><path d="M72 29Q84 20 91 10" fill="none" stroke="${v.td}" stroke-width="1.2"/>`,
	beret: (v) =>
		`<path d="M19 39C16 14 58 4 77 19C86 27 83 40 70 38Q46 32 24 43Z" fill="${v.p}"/><path d="M22 40Q46 31 72 38" fill="none" stroke="${v.t}" stroke-width="2.6" stroke-linecap="round"/><path d="M66 20Q82 10 91 4Q90 18 76 28Z" fill="${v.s}" stroke="${v.t}" stroke-width="1.2"/><path d="M68 22Q80 14 90 6" fill="none" stroke="${v.td}" stroke-width="1"/>`,
	goggles: (v) =>
		`<path d="M22 41Q50 28 78 41V45Q50 33 22 45Z" fill="#5a4636"/><circle cx="39" cy="32.4" r="8" fill="#bfeaf6" stroke="${v.t}" stroke-width="3"/><circle cx="61" cy="32.4" r="8" fill="#bfeaf6" stroke="${v.t}" stroke-width="3"/><path d="M34.5 29.5Q38 26.5 42 28.5M56.5 29.5Q60 26.5 64 28.5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><rect x="45" y="30" width="10" height="3.4" fill="${v.t}"/>`,
	coif: (v) =>
		`<path d="M19 55C17 22 83 22 81 55C77 38 65 32 50 32C35 32 23 38 19 55Z" fill="#fff" stroke="#d9deeb" stroke-width="1.2"/><path d="M24 44Q50 30 76 44" fill="none" stroke="${v.t}" stroke-width="2.4"/><path d="M48.4 18H51.6V23H56.4V26H51.6V32H48.4V26H43.6V23H48.4Z" fill="${v.p}" transform="translate(0 4)"/>`,
	tallcap: (v) =>
		`<path d="M31 33V12Q50 6 69 12V33Z" fill="${v.pd}"/><ellipse cx="50" cy="12" rx="19" ry="4.4" fill="${v.p}"/><ellipse cx="50" cy="33" rx="30" ry="5.4" fill="${v.pd}"/><path d="M31 27H69V31H31Z" fill="${v.t}"/><rect x="46" y="25.4" width="8" height="7" rx="1.4" fill="none" stroke="${v.td}" stroke-width="1.6"/>`,
	tricorn: (v) =>
		`<path d="M10 36L33 16Q50 10 67 16L90 36Q50 26 10 36Z" fill="${v.pd}"/><path d="M10 36Q50 26 90 36" fill="none" stroke="${v.t}" stroke-width="2.8"/><circle cx="50" cy="22" r="3.6" fill="${v.p}" stroke="${v.t}" stroke-width="1.4"/>`,
	turban: (v) =>
		`<path d="M21 46C19 18 81 18 79 46C70 34 30 34 21 46Z" fill="${v.pl}"/><path d="M26 38Q50 22 74 38M23 44Q50 28 77 44" fill="none" stroke="${v.p}" stroke-width="2.4"/><path d="M50 22l2.6 4 4.6.6-3.4 3.2.9 4.6-4.7-2.4-4.7 2.4.9-4.6-3.4-3.2 4.6-.6z" fill="${v.t}" stroke="${v.td}" stroke-width="1"/>`,
	softcap: (v) =>
		`<path d="M23 41C20 17 76 12 78 38Q50 32 23 41Z" fill="${v.pl}"/><path d="M23 41Q50 32 78 38" fill="none" stroke="${v.p}" stroke-width="3"/><path d="M68 28Q80 20 88 6Q90 22 78 34Z" fill="${v.s}" stroke="${v.td}" stroke-width="1.2"/><path d="M70 28Q80 20 87 8" fill="none" stroke="${v.td}" stroke-width="1"/>`,
	hardhat: (v) =>
		`<path d="M25 41C24 11 76 11 75 41Z" fill="${v.t}"/><rect x="21" y="37" width="58" height="6.4" rx="3.2" fill="${v.td}"/><path d="M50 15V37M40 18V37M60 18V37" stroke="${v.td}" stroke-width="2" opacity=".5"/><circle cx="50" cy="24" r="5" fill="#fff" stroke="${v.ink}" stroke-width="1.6"/><circle cx="50" cy="24" r="2" fill="#ffe68a"/>`,
	wreath: (v) =>
		`<g fill="#4fae6c"><ellipse cx="28" cy="40" rx="6" ry="3.2" transform="rotate(60 28 40)"/><ellipse cx="31" cy="31" rx="6" ry="3.2" transform="rotate(30 31 31)"/><ellipse cx="40" cy="26" rx="6" ry="3.2" transform="rotate(8 40 26)"/><ellipse cx="50" cy="24" rx="6" ry="3.2"/><ellipse cx="60" cy="26" rx="6" ry="3.2" transform="rotate(-8 60 26)"/><ellipse cx="69" cy="31" rx="6" ry="3.2" transform="rotate(-30 69 31)"/><ellipse cx="72" cy="40" rx="6" ry="3.2" transform="rotate(-60 72 40)"/></g><g fill="#2f8a50"><ellipse cx="36" cy="28" rx="5" ry="2.6" transform="rotate(-20 36 28)"/><ellipse cx="64" cy="28" rx="5" ry="2.6" transform="rotate(20 64 28)"/></g><circle cx="50" cy="24" r="2.6" fill="${v.p}"/><circle cx="31" cy="32" r="2.2" fill="${v.t}"/><circle cx="69" cy="32" r="2.2" fill="${v.t}"/>`,
	toque: (v) =>
		`<path d="M31 37V30C22 28 21 12 36 12C38 5 62 5 64 12C79 12 78 28 69 30V37Z" fill="#fff" stroke="#d9deeb" stroke-width="1.2"/><rect x="31" y="32" width="38" height="6" rx="2" fill="${v.s}" stroke="#d9deeb" stroke-width="1"/><path d="M42 14Q43 24 41 30M58 14Q57 24 59 30" fill="none" stroke="#e1e5f0" stroke-width="1.4"/>`,
	kettle: (v) =>
		`<path d="M28 33C28 8 72 8 72 33Z" fill="${STEEL}"/><ellipse cx="50" cy="33" rx="38" ry="6.4" fill="${STEELD}"/><path d="M34 22Q50 12 66 22" fill="none" stroke="#fff" stroke-width="2" opacity=".5"/><circle cx="50" cy="17" r="2.4" fill="${v.t}"/><path d="M28 27H72" stroke="${v.p}" stroke-width="3"/>`,
	cavalier: (v) =>
		`<path d="M62 20Q80 4 92 6Q88 24 70 30Z" fill="${v.s}" stroke="${v.t}" stroke-width="1.4"/><path d="M30 33C30 14 70 14 70 33Z" fill="${v.p}"/><path d="M10 35Q50 18 90 35Q50 42 10 35Z" fill="${v.pd}"/><path d="M30 31Q50 36 70 31" fill="none" stroke="${v.t}" stroke-width="2.6"/>`,
	cowl: (v) =>
		`<path d="M19 54C16 30 38 14 58 3C58 18 82 32 81 54C75 41 63 34 50 34C37 34 25 41 19 54Z" fill="${v.pd}"/><path d="M26 44Q50 30 74 44" fill="none" stroke="${v.ink}" stroke-width="2" opacity=".3"/>`,
	headband: (v) =>
		`<path d="M22 39Q50 29 78 39V44.5Q50 34.5 22 44.5Z" fill="${v.p}"/><path d="M76 40Q86 38 90 46M76 42Q88 46 88 56" fill="none" stroke="${v.p}" stroke-width="3.2" stroke-linecap="round"/><circle cx="50" cy="31.5" r="2.4" fill="${v.t}"/>`,
	fcap: (v) =>
		`<path d="M23 42C22 20 78 18 77 40Q50 31 23 42Z" fill="${v.pd}"/><path d="M23 42Q50 31 77 40" fill="none" stroke="${v.t}" stroke-width="2.4"/><path d="M60 26Q78 22 94 8Q86 28 70 34Z" fill="${v.s}" stroke="${v.td}" stroke-width="1.2"/><path d="M62 28Q80 22 92 10" fill="none" stroke="${v.td}" stroke-width="1"/>`,
	sailor: (v) =>
		`<path d="M26 38C26 18 74 18 74 38Z" fill="#fff" stroke="#d9deeb" stroke-width="1.2"/><rect x="25" y="34" width="50" height="7" rx="3.4" fill="${v.pd}"/><path d="M50 14V22" stroke="${v.p}" stroke-width="3.4" stroke-linecap="round"/><path d="M26 28H74" stroke="${v.p}" stroke-width="2" opacity=".6"/>`,
	jester: (v) =>
		`<path d="M26 40C14 30 12 14 18 6C28 16 32 26 42 33Z" fill="${v.p}"/><path d="M74 40C86 30 88 14 82 6C72 16 68 26 58 33Z" fill="${v.s}" stroke="${v.sd}" stroke-width="1"/><path d="M26 40C26 28 74 28 74 40Q50 34 26 40Z" fill="${v.pd}"/><circle cx="18" cy="6" r="4" fill="${v.t}" stroke="${v.td}" stroke-width="1"/><circle cx="82" cy="6" r="4" fill="${v.t}" stroke="${v.td}" stroke-width="1"/><circle cx="50" cy="31" r="3.4" fill="${v.t}"/>`,
	winghelm: (v) =>
		`<path d="M24 36Q6 31 3 14Q18 14 30 27Z" fill="${v.s}" stroke="${v.t}" stroke-width="1.6"/><path d="M76 36Q94 31 97 14Q82 14 70 27Z" fill="${v.s}" stroke="${v.t}" stroke-width="1.6"/><path d="M23 47C21 23 79 23 77 47L72 39Q50 31 28 39Z" fill="#e6eaf3"/><path d="M28 39Q50 31 72 39" fill="none" stroke="${v.t}" stroke-width="3"/><path d="M26 36Q50 24 74 36" fill="none" stroke="#fff" stroke-width="2" opacity=".7"/><path d="M50 26l2.4 4.4 4.8.8-3.4 3.4.8 4.8-4.6-2.2-4.6 2.2.8-4.8-3.4-3.4 4.8-.8z" fill="${v.t}" transform="translate(0 -1)"/>`,
};
