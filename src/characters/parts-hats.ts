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
		`<path d="M30 29L33 13Q50 8 67 13L70 29Q50 34 30 29Z" fill="${v.p}"/><path d="M41 10.6L39 30.4M50 9.2V32M59 10.6L61 30.4" fill="none" stroke="${v.pd}" stroke-width="2" stroke-linecap="round"/><path d="M27.6 29.4Q50 36 72.4 29.4V36.6Q50 43.4 27.6 36.6Z" fill="${v.pd}"/><path d="M28 33Q50 39.6 72 33" fill="none" stroke="${v.t}" stroke-width="1.6" opacity=".9"/><circle cx="50" cy="8.2" r="3.2" fill="${v.t}" stroke="${v.td}" stroke-width="1"/>`,
	goggcap: (v) =>
		`<path d="M22.4 42Q20.4 53 24.4 61Q29 59.6 30 52L30.4 42Z" fill="${v.pd}"/><path d="M77.6 42Q79.6 53 75.6 61Q71 59.6 70 52L69.6 42Z" fill="${v.pd}"/><path d="M24.4 61l-1 4.4M75.6 61l1 4.4" stroke="${v.t}" stroke-width="1.4" stroke-linecap="round"/><path d="M23 42C22 20 78 20 77 42Q50 33 23 42Z" fill="${v.p}"/><path d="M50 25V34.6" fill="none" stroke="${v.pd}" stroke-width="1.6" opacity=".6"/><path d="M22.4 38.5Q50 29.5 77.6 38.5L77 43.5Q50 34.5 23 43.5Z" fill="${v.pd}"/><circle cx="36.5" cy="37.8" r="1.4" fill="${v.t}"/><circle cx="50" cy="36.4" r="1.4" fill="${v.t}"/><circle cx="63.5" cy="37.8" r="1.4" fill="${v.t}"/>`,
	hood: (v) =>
		`<path d="M21 53C20 26 80 26 79 53C76 40 66 33.5 50 33.5C34 33.5 24 40 21 53Z" fill="${v.p}"/><path d="M21 53C20 26 80 26 79 53" fill="none" stroke="${v.pd}" stroke-width="2"/><path d="M70 33Q90 24 93 8Q76 12 66 30Z" fill="${v.t}"/><path d="M72 29Q84 20 91 10" fill="none" stroke="${v.td}" stroke-width="1.2"/>`,
	beret: (v) =>
		`<path d="M27 36C20 14 56 6 70 16C84 26 80 36 74 40Q50 33 27 36Z" fill="${v.p}"/><path d="M60 12C70 10 76 14 74 18" fill="none" stroke="${v.pd}" stroke-width="1.6" stroke-linecap="round"/><path d="M22 38C22 30 78 30 78 38C78 47 66 43 50 43C34 43 22 47 22 38Z" fill="${v.pd}"/><path d="M26 38.4Q50 33 74 38.4" fill="none" stroke="${v.t}" stroke-width="1.6" stroke-dasharray="2.6 2.2" stroke-linecap="round"/><path d="M71 17C88 22 93 42 88 66L83 64C86 46 80 34 70 26Z" fill="${v.p}" stroke="${v.pd}" stroke-width="1"/><circle cx="85.4" cy="67" r="2.6" fill="${v.t}"/>`,
	goggles: (v) =>
		`<path d="M23 42C22 26 40 15 55 12C62 9 66 13 61 17C73 23 78 32 77 42Q50 33 23 42Z" fill="${v.p}"/><path d="M36 30Q50 21 62 24" fill="none" stroke="${v.pd}" stroke-width="1.6" stroke-linecap="round" opacity=".6"/><path d="M22.4 38.5Q50 29.5 77.6 38.5L77 43.5Q50 34.5 23 43.5Z" fill="${v.pl}"/><circle cx="50" cy="36.6" r="1.8" fill="${v.t}"/>`,
	coif: (v) =>
		`<path d="M19 55C17 22 83 22 81 55C77 38 65 32 50 32C35 32 23 38 19 55Z" fill="#fff" stroke="#d9deeb" stroke-width="1.2"/><path d="M24 44Q50 30 76 44" fill="none" stroke="${v.t}" stroke-width="2.4"/><path d="M48.4 18H51.6V23H56.4V26H51.6V32H48.4V26H43.6V23H48.4Z" fill="${v.p}" transform="translate(0 4)"/>`,
	tallcap: (v) =>
		`<path d="M35 36L31 8Q50 3 69 8L65 36Z" fill="${v.pd}"/><ellipse cx="50" cy="8" rx="19" ry="3.8" fill="${v.p}"/><path d="M31.4 30.6Q50 36.6 68.6 30.6V36.4Q50 42.4 31.4 36.4Z" fill="${v.t}"/><path d="M24 38Q50 47 76 38Q76 41 70 40Q50 45 30 40Q24 41 24 38Z" fill="${v.pd}"/><circle cx="50" cy="35.4" r="2.6" fill="${v.p}" stroke="${v.td}" stroke-width="1"/>`,
	tricorn: (v) =>
		`<path d="M7 38Q50 24 93 38Q50 49 7 38Z" fill="${v.pd}"/><path d="M28 37C26 14 74 14 72 37Q50 31 28 37Z" fill="${v.p}"/><path d="M27.4 34.6Q50 41 72.6 34.6" fill="none" stroke="${v.t}" stroke-width="2.4"/><path d="M50 36C41 36 40 26 42 23.6Q46 21 50 20.4Q54 21 58 23.6C60 26 59 36 50 36Z" fill="${v.t}" stroke="${v.td}" stroke-width="1"/><path d="M50 35V21M45.6 34L43.6 25M54.4 34L56.4 25" fill="none" stroke="${v.td}" stroke-width="1"/>`,
	turban: (v) =>
		`<path d="M21 46C19 18 81 18 79 46C70 34 30 34 21 46Z" fill="${v.pl}"/><path d="M26 38Q50 22 74 38M23 44Q50 28 77 44" fill="none" stroke="${v.p}" stroke-width="2.4"/><path d="M50 22l2.6 4 4.6.6-3.4 3.2.9 4.6-4.7-2.4-4.7 2.4.9-4.6-3.4-3.2 4.6-.6z" fill="${v.t}" stroke="${v.td}" stroke-width="1"/>`,
	softcap: (v) =>
		`<path d="M25 38C14 24 28 12 50 12C72 12 86 24 75 38Z" fill="${v.pl}"/><path d="M33 22Q50 14 67 22" fill="none" stroke="${v.p}" stroke-width="1.6" stroke-linecap="round" opacity=".55"/><path d="M22 37Q50 27 78 37V44Q50 34 22 44Z" fill="${v.p}"/><path d="M25 38.6Q50 29.6 75 38.6" fill="none" stroke="${v.t}" stroke-width="1.4" stroke-dasharray="2.4 2" stroke-linecap="round"/><circle cx="50" cy="12.4" r="2.4" fill="${v.p}"/>`,
	hardhat: (v) =>
		`<path d="M25 40C23 10 77 10 75 40Z" fill="${STEEL}" stroke="${STEELD}" stroke-width="1.4"/><path d="M50 12V37" fill="none" stroke="${STEELD}" stroke-width="2.4"/><path d="M30 25Q36 17 44 15" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".7"/><rect x="21.6" y="34.4" width="56.8" height="6" rx="3" fill="${v.t}" stroke="${v.td}" stroke-width="1"/><circle cx="34" cy="37.4" r="1.3" fill="${STEELD}"/><circle cx="50" cy="37.4" r="1.3" fill="${STEELD}"/><circle cx="66" cy="37.4" r="1.3" fill="${STEELD}"/>`,
	wreath: (v) =>
		`<g fill="#4fae6c"><ellipse cx="28" cy="40" rx="6" ry="3.2" transform="rotate(60 28 40)"/><ellipse cx="31" cy="31" rx="6" ry="3.2" transform="rotate(30 31 31)"/><ellipse cx="40" cy="26" rx="6" ry="3.2" transform="rotate(8 40 26)"/><ellipse cx="50" cy="24" rx="6" ry="3.2"/><ellipse cx="60" cy="26" rx="6" ry="3.2" transform="rotate(-8 60 26)"/><ellipse cx="69" cy="31" rx="6" ry="3.2" transform="rotate(-30 69 31)"/><ellipse cx="72" cy="40" rx="6" ry="3.2" transform="rotate(-60 72 40)"/></g><g fill="#2f8a50"><ellipse cx="36" cy="28" rx="5" ry="2.6" transform="rotate(-20 36 28)"/><ellipse cx="64" cy="28" rx="5" ry="2.6" transform="rotate(20 64 28)"/></g><circle cx="50" cy="24" r="2.6" fill="${v.p}"/><circle cx="31" cy="32" r="2.2" fill="${v.t}"/><circle cx="69" cy="32" r="2.2" fill="${v.t}"/>`,
	toque: (v) =>
		`<path d="M29 39C22 25 33 11 50 12C67 11 78 25 71 39Z" fill="#fff" stroke="#d9deeb" stroke-width="1.2"/><path d="M38 17Q41 27 37 35M50 15Q51 26 50 35M62 17Q59 27 63 35" fill="none" stroke="#e1e5f0" stroke-width="1.4"/><rect x="28" y="33.6" width="44" height="6.6" rx="3.2" fill="${v.s}" stroke="#d9deeb" stroke-width="1"/><path d="M32 35.6H68" stroke="${v.p}" stroke-width="1.6" stroke-linecap="round" opacity=".7"/>`,
	kettle: (v) =>
		`<path d="M28 33C28 8 72 8 72 33Z" fill="${STEEL}"/><ellipse cx="50" cy="33" rx="38" ry="6.4" fill="${STEELD}"/><path d="M34 22Q50 12 66 22" fill="none" stroke="#fff" stroke-width="2" opacity=".5"/><circle cx="50" cy="17" r="2.4" fill="${v.t}"/><path d="M28 27H72" stroke="${v.p}" stroke-width="3"/>`,
	cavalier: (v) =>
		`<path d="M63 18Q82 2 94 6Q91 26 72 30Z" fill="${v.s}" stroke="${v.t}" stroke-width="1.4"/><path d="M66 21Q80 10 92 7" fill="none" stroke="${v.t}" stroke-width="1"/><path d="M31 36C28 12 72 12 69 36Z" fill="${v.p}"/><path d="M21 38Q23 29 31 33Q50 40 69 33Q77 29 79 38Q50 47 21 38Z" fill="${v.pd}"/><path d="M30.4 32.4Q50 38.4 69.6 32.4" fill="none" stroke="${v.t}" stroke-width="2.2"/><circle cx="62" cy="33" r="2.6" fill="${v.t}" stroke="${v.td}" stroke-width="1"/>`,
	cowl: (v) =>
		`<path d="M19 54C16 30 38 14 58 3C58 18 82 32 81 54C75 41 63 34 50 34C37 34 25 41 19 54Z" fill="${v.pd}"/><path d="M26 44Q50 30 74 44" fill="none" stroke="${v.ink}" stroke-width="2" opacity=".3"/>`,
	headband: (v) =>
		`<path d="M22 39Q50 29 78 39V44.5Q50 34.5 22 44.5Z" fill="${v.p}"/><path d="M76 40Q86 38 90 46M76 42Q88 46 88 56" fill="none" stroke="${v.p}" stroke-width="3.2" stroke-linecap="round"/><circle cx="50" cy="31.5" r="2.4" fill="${v.t}"/>`,
	fcap: (v) =>
		`<path d="M28 37C27 15 71 11 73 36Z" fill="${v.pd}"/><path d="M60 24Q78 22 94 8Q87 29 70 35Z" fill="${v.s}" stroke="${v.td}" stroke-width="1.2"/><path d="M62 27Q79 22 92 10" fill="none" stroke="${v.td}" stroke-width="1"/><path d="M14 33Q50 26 86 33Q76 42 50 41Q24 42 14 33Z" fill="${v.p}"/><path d="M28 33Q50 38 72 33" fill="none" stroke="${v.t}" stroke-width="1.8"/>`,
	sailor: (v) =>
		`<path d="M9 37Q50 26 91 37Q50 49 9 37Z" fill="#e8d194" stroke="#c9a867" stroke-width="1.2"/><path d="M29 36C27 15 73 15 71 36Q50 31 29 36Z" fill="#f2e0a8"/><path d="M29.4 33.2Q50 38.4 70.6 33.2" fill="none" stroke="${v.p}" stroke-width="3.4"/><path d="M36 22Q50 17 64 22M33 28Q50 22 67 28" fill="none" stroke="#d9c07a" stroke-width="1.2" stroke-linecap="round"/><path d="M14 37.6Q50 44 86 37.6" fill="none" stroke="#c9a867" stroke-width="1" opacity=".7"/>`,
	jester: (v) =>
		`<path d="M26 40C14 30 12 14 18 6C28 16 32 26 42 33Z" fill="${v.p}"/><path d="M74 40C86 30 88 14 82 6C72 16 68 26 58 33Z" fill="${v.s}" stroke="${v.sd}" stroke-width="1"/><path d="M26 40C26 28 74 28 74 40Q50 34 26 40Z" fill="${v.pd}"/><circle cx="18" cy="6" r="4" fill="${v.t}" stroke="${v.td}" stroke-width="1"/><circle cx="82" cy="6" r="4" fill="${v.t}" stroke="${v.td}" stroke-width="1"/><circle cx="50" cy="31" r="3.4" fill="${v.t}"/>`,
	winghelm: (v) =>
		`<path d="M24 36Q6 31 3 14Q18 14 30 27Z" fill="${v.s}" stroke="${v.t}" stroke-width="1.6"/><path d="M76 36Q94 31 97 14Q82 14 70 27Z" fill="${v.s}" stroke="${v.t}" stroke-width="1.6"/><path d="M23 47C21 23 79 23 77 47L72 39Q50 31 28 39Z" fill="#e6eaf3"/><path d="M28 39Q50 31 72 39" fill="none" stroke="${v.t}" stroke-width="3"/><path d="M26 36Q50 24 74 36" fill="none" stroke="#fff" stroke-width="2" opacity=".7"/><path d="M50 26l2.4 4.4 4.8.8-3.4 3.4.8 4.8-4.6-2.2-4.6 2.2.8-4.8-3.4-3.4 4.8-.8z" fill="${v.t}" transform="translate(0 -1)"/>`,
};
