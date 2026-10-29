import type { PropId } from "./catalog.ts";
import type { Part } from "./colors.ts";
import { hand, star5 } from "./parts-outfits.ts";

const WOOD = "#8b5a33";
const LEATHER = "#a6713f";

/** The part's markup as it is; the pivot its animation turns about is in `PROP_PIVOTS`. */
const held = (inner: string): string => inner;

/** Where each prop turns when it sweeps, in the 100-unit drawing (applied by characters.css). */
export const PROP_PIVOTS: Readonly<Record<PropId, string>> = {
	staff: "73px 82px",
	shield: "27px 82px",
	scroll: "76px 76px",
	hammer: "79px 84px",
	bow: "78px 70px",
	lute: "75px 70px",
	flask: "73px 66px",
	quill: "72px 82px",
	tome: "78px 76px",
	bell: "76px 62px",
	keys: "78px 62px",
	map: "77px 58px",
	telescope: "76px 74px",
	wrench: "78px 86px",
	spade: "76px 60px",
	ladle: "78px 78px",
	lantern: "76px 62px",
	seal: "76px 66px",
	dagger: "78px 86px",
	beads: "78px 62px",
	bird: "78px 76px",
	anchor: "76px 76px",
	marotte: "76px 62px",
	sword: "76px 82px",
};

export const PROPS: Record<PropId, Part> = {
	staff: (v) =>
		held(
			`<circle class="glow" cx="73" cy="15" r="13" fill="${v.gl}"/><path d="M73 15V92" stroke="${WOOD}" stroke-width="4.2" stroke-linecap="round"/><circle cx="73" cy="14" r="6.4" fill="${v.gl}" stroke="${v.t}" stroke-width="2"/><circle cx="71" cy="12" r="1.8" fill="#fff" opacity=".85"/>${hand(v, 73, 82)}`,
		),
	shield: (v) =>
		held(
			`<path class="glow" d="M17 70H37V80Q37 89 27 93.5Q17 89 17 80Z" fill="none" stroke="${v.gl}" stroke-width="6"/><path d="M17 70H37V80Q37 89 27 93.5Q17 89 17 80Z" fill="${v.s}" stroke="${v.t}" stroke-width="2"/><path d="M17 70H27V93.5Q17 89 17 80Z" fill="${v.p}"/>` +
				star5(27, 79, v.t),
		),
	scroll: (v) =>
		held(
			`<g transform="rotate(-16 76 74)"><path class="glow" d="M76 38l2.4 5.4 5.7.6-4.3 3.9 1.2 5.7-5-2.9-5 2.9 1.2-5.7-4.3-3.9 5.7-.6z" fill="${v.t}"/><rect x="69.5" y="56" width="13" height="30" rx="2" fill="#fbefd0" stroke="#c9a867" stroke-width="1.2"/><ellipse cx="76" cy="56" rx="7.4" ry="2.8" fill="#f1d99b" stroke="#c9a867" stroke-width="1.2"/><ellipse cx="76" cy="86" rx="7.4" ry="2.8" fill="#f1d99b" stroke="#c9a867" stroke-width="1.2"/><path d="M72.5 63H79.5M72.5 68H79.5M72.5 73H77" stroke="${v.p}" stroke-width="1.6" stroke-linecap="round"/></g>${hand(v, 75.5, 74, 4.6)}`,
		),
	hammer: (v) =>
		held(
			`<path class="glow" d="M89 49l1.8 4 4.2.4-3.2 2.9.9 4.2-3.7-2.2-3.7 2.2.9-4.2-3.2-2.9 4.2-.4z" fill="${v.t}"/><path d="M78 95L82 70" stroke="${WOOD}" stroke-width="4.4" stroke-linecap="round"/><g transform="rotate(8 81 66)"><rect x="68" y="59" width="26" height="14" rx="3.4" fill="#aab3c5" stroke="#7d879b" stroke-width="1.4"/><rect x="68" y="59" width="7" height="14" rx="3" fill="#8b95a9"/><path d="M73 61.4H90" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".6"/></g>${hand(v, 79.4, 85)}`,
		),
	bow: (v) =>
		held(
			`<circle class="glow" cx="94" cy="70" r="8" fill="${v.gl}"/><path d="M74 40Q98 68 74 96" fill="none" stroke="${WOOD}" stroke-width="4.2" stroke-linecap="round"/><path d="M74 40V96" stroke="#9aa5ba" stroke-width="1" opacity=".9"/><path d="M66 70H94" stroke="${WOOD}" stroke-width="1.8" stroke-linecap="round"/><path d="M93 66.5L99 70L93 73.5Z" fill="${v.t}"/><path d="M66 70l-3.4-3M66 70l-3.4 3" stroke="${v.p}" stroke-width="1.8" stroke-linecap="round"/>${hand(v, 78, 70)}`,
		),
	lute: (v) =>
		held(
			`<g transform="rotate(18 76 80)"><path d="M74.2 70V44" stroke="${WOOD}" stroke-width="3.8"/><rect x="72.6" y="38" width="6.4" height="8" rx="1.6" fill="#6d4426"/><ellipse cx="76" cy="82" rx="11.4" ry="12.6" fill="#cd8b4a" stroke="#9a5f2c" stroke-width="1.6"/><circle cx="76" cy="82" r="3.6" fill="${v.ink}"/><path d="M74.8 46V88M77.2 46V88" stroke="#fff" stroke-width=".8" opacity=".85"/></g><g class="glow"><circle cx="89" cy="54" r="2.8" fill="${v.gl}"/><path d="M91.5 54V41q4.2 1 4.4 6" fill="none" stroke="${v.gl}" stroke-width="2" stroke-linecap="round"/></g>${hand(v, 75, 68, 4.6)}`,
		),
	flask: (v) =>
		held(
			`<circle class="glow" cx="73.5" cy="78" r="17" fill="${v.gl}"/><rect x="70" y="56" width="7" height="12" fill="#eaf7fb" stroke="#9fc9d8" stroke-width="1.4"/><rect x="69" y="51.5" width="9" height="5.6" rx="1.6" fill="#b7773f"/><circle cx="73.5" cy="78" r="12.4" fill="#eaf7fb" stroke="#9fc9d8" stroke-width="1.6"/><path d="M61.4 77Q73.5 72.6 85.6 77A12.2 12.2 0 0 1 61.4 77Z" fill="${v.gl}"/><circle cx="70" cy="80" r="1.8" fill="#fff" opacity=".8"/><circle cx="76.5" cy="83.5" r="1.2" fill="#fff" opacity=".8"/>${hand(v, 73.5, 64)}`,
		),
	quill: (v) =>
		held(
			`<circle class="glow" cx="92" cy="30" r="8" fill="${v.t}"/><path d="M70 88C70 62 80 40 92 30C95 50 86 72 70 88Z" fill="${v.s}" stroke="${v.td}" stroke-width="1.3"/><path d="M70 88Q80 58 92 30" fill="none" stroke="${v.td}" stroke-width="1.5"/><path d="M80 52Q86 54 89 48M77 62Q84 63 88 57" fill="none" stroke="${v.sd}" stroke-width="1.3"/><path d="M70 88l-3 5" stroke="${v.ink}" stroke-width="2" stroke-linecap="round"/>${hand(v, 72.4, 80)}`,
		),
	tome: (v) =>
		held(
			`<circle class="glow" cx="80" cy="60" r="9" fill="${v.t}"/><g transform="rotate(-12 78 76)"><rect x="65" y="63" width="25" height="24" rx="2.4" fill="${v.pd}" stroke="${v.ink}" stroke-width="1" stroke-opacity=".3"/><rect x="67.4" y="65.4" width="20" height="19" rx="1.4" fill="none" stroke="${v.t}" stroke-width="1.2"/><path d="M90 66V84" stroke="#f8efd6" stroke-width="3"/><rect x="72" y="71" width="9" height="7" rx="1.4" fill="${v.t}"/></g>${hand(v, 66, 80, 4.4)}`,
		),
	bell: (v) =>
		held(
			`<g class="glow"><path d="M90 66q4 6 0 12M94 62q7 10 0 20" fill="none" stroke="${v.gl}" stroke-width="2" stroke-linecap="round"/></g><path d="M66 85C70 83 69 68 76 66C83 68 82 83 86 85Z" fill="${v.t}" stroke="${v.td}" stroke-width="1.4" stroke-linejoin="round"/><circle cx="76" cy="87.6" r="2.4" fill="${v.td}"/><rect x="73.4" y="60" width="5.2" height="6.4" rx="1.6" fill="${WOOD}"/>${hand(v, 76, 60, 4.4)}`,
		),
	keys: (v) =>
		held(
			`<circle class="glow" cx="79" cy="80" r="14" fill="${v.t}"/><circle cx="78" cy="62" r="5.6" fill="none" stroke="${v.t}" stroke-width="2.6"/><path d="M82 66L90 88M90 88L93 87M87 82L90 81" fill="none" stroke="${v.t}" stroke-width="2.6" stroke-linecap="round"/><path d="M74 66L70 84M70 84L73 85M71 78L74 78" fill="none" stroke="${v.td}" stroke-width="2.6" stroke-linecap="round"/>${hand(v, 78, 62, 4.4)}`,
		),
	map: (v) =>
		held(
			`<circle class="glow" cx="81" cy="76" r="8" fill="${v.p}"/><rect x="66" y="58" width="24" height="29" rx="2" fill="#f3e2b5" stroke="#c9a867" stroke-width="1.3"/><path d="M70 66Q78 62 82 70T86 80M70 82L74 76" fill="none" stroke="#8ec7d8" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 2.4"/><path d="M81 71.4l1.4 3.6 3.6 1.4-3.6 1.4-1.4 3.6-1.4-3.6-3.6-1.4 3.6-1.4z" fill="${v.p}"/>${hand(v, 78, 58, 4.4)}`,
		),
	telescope: (v) =>
		held(
			`<circle class="glow" cx="76" cy="72" r="17" fill="${v.gl}"/><circle cx="76" cy="54.6" r="3.6" fill="none" stroke="${v.td}" stroke-width="2"/><path d="M73 57.4Q76 60 79 57.4" fill="none" stroke="${v.t}" stroke-width="2.4"/><circle cx="76" cy="72" r="13.4" fill="${v.t}" stroke="${v.td}" stroke-width="1.6"/><circle cx="76" cy="72" r="10" fill="#fbefd0" stroke="${v.td}" stroke-width="1"/><path d="M66 72H86M76 62V82" stroke="${v.td}" stroke-width="1.2"/><circle cx="76" cy="72" r="5.6" fill="none" stroke="${v.td}" stroke-width="1"/><path d="M70 66.6L82 77.4" stroke="${v.p}" stroke-width="1.6" stroke-linecap="round"/><circle cx="82" cy="65.6" r="1.8" fill="${v.p}"/>${hand(v, 76, 57, 4.4)}`,
		),
	wrench: (v) =>
		held(
			`<path class="glow" d="M90 52l1.6 3.6 3.8.4-2.8 2.6.8 3.8-3.4-2-3.4 2 .8-3.8-2.8-2.6 3.8-.4z" fill="${v.t}"/><path d="M79 60L71 93M79 60L87 91" stroke="#aab3c5" stroke-width="3.4" stroke-linecap="round"/><path d="M79 60L71 93M79 60L87 91" stroke="#fff" stroke-width="1" stroke-linecap="round" opacity=".5"/><path d="M71 93l-.8 2.2M87 91l.8 2.2" stroke="#7d879b" stroke-width="1.6" stroke-linecap="round"/><path d="M73.4 81Q79 85 84.6 81" fill="none" stroke="#7d879b" stroke-width="1.6" stroke-linecap="round"/><circle cx="79" cy="60" r="3.4" fill="${v.t}" stroke="${v.td}" stroke-width="1.2"/>${hand(v, 79, 63.4, 4.4)}`,
		),
	spade: (v) =>
		held(
			`<g class="glow"><ellipse cx="88" cy="62" rx="4.4" ry="2.4" transform="rotate(-30 88 62)" fill="#4fae6c"/><ellipse cx="91" cy="70" rx="4" ry="2.2" transform="rotate(20 91 70)" fill="#4fae6c"/></g><path d="M76 92V56" stroke="${WOOD}" stroke-width="4" stroke-linecap="round"/><path d="M70 56H82" stroke="${WOOD}" stroke-width="3.4" stroke-linecap="round"/><path d="M69.5 78H82.5V88Q76 97 69.5 88Z" fill="#aab3c5" stroke="#7d879b" stroke-width="1.3" stroke-linejoin="round"/>${hand(v, 76, 59)}`,
		),
	ladle: (v) =>
		held(
			`<g class="glow"><path d="M88 48q-3-4 0-8M93 50q-3-4 0-8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></g><path d="M74 94L82 62" stroke="${WOOD}" stroke-width="4" stroke-linecap="round"/><path d="M73 58H93A10 8 0 0 1 73 58Z" fill="#aab3c5" stroke="#7d879b" stroke-width="1.3" stroke-linejoin="round" transform="rotate(-14 83 58)"/><ellipse cx="83" cy="57" rx="8" ry="2" fill="#c97b3a" transform="rotate(-14 83 57)"/>${hand(v, 76.4, 82)}`,
		),
	lantern: (v) =>
		held(
			`<circle class="glow" cx="77" cy="78" r="20" fill="#ffd84a"/><path d="M69 66Q77 52 85 66" fill="none" stroke="${v.td}" stroke-width="2.2"/><rect x="69" y="66" width="16" height="4" rx="1.6" fill="${v.t}"/><rect x="70.4" y="70" width="13.2" height="16" fill="#fff3c2" stroke="${v.td}" stroke-width="1.4"/><path d="M77 73Q81 78 77 83Q73 78 77 73Z" fill="#ffa63a"/><rect x="69" y="86" width="16" height="4" rx="1.6" fill="${v.t}"/>${hand(v, 77, 60, 4.4)}`,
		),
	seal: (v) =>
		held(
			`<circle class="glow" cx="79" cy="78" r="9" fill="${v.p}"/><g transform="rotate(-10 78 74)"><rect x="66" y="64" width="26" height="18" rx="2" fill="#fff7e6" stroke="#d3bd8e" stroke-width="1.2"/><path d="M66 65L79 75L92 65" fill="none" stroke="#d3bd8e" stroke-width="1.2"/><circle cx="79" cy="75" r="4.6" fill="${v.p}" stroke="${v.pd}" stroke-width="1"/>${star5(79, 75, v.t).replace('d="M', 'transform="scale(.6) translate(52 50)" d="M')}</g>${hand(v, 70, 82, 4.4)}`,
		),
	dagger: (v) =>
		held(
			`<path class="glow" d="M78 50V80" stroke="#fff" stroke-width="5" stroke-linecap="round"/><path d="M78 52L82.4 78H73.6Z" fill="#dfe5f0" stroke="#9aa5ba" stroke-width="1.2" stroke-linejoin="round"/><path d="M78 56V76" stroke="#fff" stroke-width="1.2" opacity=".7"/><rect x="71" y="78" width="14" height="3.4" rx="1.6" fill="${v.t}"/><rect x="76.4" y="81" width="3.2" height="8" fill="${WOOD}"/>${hand(v, 78, 86)}`,
		),
	beads: (v) =>
		held(
			`<g class="glow"><circle cx="78" cy="78" r="12" fill="${v.t}"/></g><g fill="${v.t}" stroke="${v.td}" stroke-width="1"><circle cx="78" cy="66" r="2.4"/><circle cx="84.4" cy="68.4" r="2.4"/><circle cx="87" cy="75" r="2.4"/><circle cx="85.6" cy="82" r="2.4"/><circle cx="80.4" cy="86.6" r="2.4"/><circle cx="73.6" cy="86.6" r="2.4"/><circle cx="68.4" cy="82" r="2.4"/><circle cx="67" cy="75" r="2.4"/><circle cx="71.6" cy="68.4" r="2.4"/></g>${hand(v, 78, 62, 4.4)}`,
		),
	bird: (v) =>
		held(
			`<circle class="glow" cx="88" cy="55" r="8" fill="${v.t}"/><ellipse cx="80" cy="64" rx="9" ry="6.4" transform="rotate(-24 80 64)" fill="#8a6a4a"/><path d="M72 70L66 76L76 70Z" fill="#6f5338"/><path d="M76 66Q82 64 86 66Q82 70 78 70Z" fill="#f1e2c4"/><circle cx="87" cy="56" r="5" fill="#8a6a4a"/><path d="M91 55L96 57L91 59Z" fill="${v.t}"/><circle cx="88" cy="55" r="1.3" fill="${v.ink}"/><path d="M78 70V75" stroke="${v.t}" stroke-width="2"/><circle cx="78" cy="79" r="6.2" fill="${LEATHER}" stroke="#7a4f27" stroke-width="1.2"/>`,
		),
	anchor: (v) =>
		held(
			`<path class="glow" d="M76 54l2 4.4 4.8.5-3.6 3.2 1 4.7-4.2-2.4-4.2 2.4 1-4.7-3.6-3.2 4.8-.5z" fill="${v.t}" transform="translate(11 -4)"/><circle cx="76" cy="58" r="3.4" fill="none" stroke="#aab3c5" stroke-width="2.4"/><path d="M76 61.4V90M69.6 66H82.4M65 82Q76 98 87 82" fill="none" stroke="#aab3c5" stroke-width="3.4" stroke-linecap="round"/><path d="M65 82L63 86M87 82L89 86" stroke="#aab3c5" stroke-width="3.4" stroke-linecap="round"/>${hand(v, 76, 74)}`,
		),
	marotte: (v) =>
		held(
			`<g class="glow"><circle cx="66" cy="40" r="3" fill="${v.t}"/><circle cx="86" cy="40" r="3" fill="${v.t}"/></g><path d="M76 94V52" stroke="${WOOD}" stroke-width="4" stroke-linecap="round"/><circle cx="76" cy="46" r="7" fill="${v.k}" stroke="${v.kd}" stroke-width="1"/><path d="M70 42Q64 36 66 40Q68 42 71 44ZM82 42Q88 36 86 40Q84 42 81 44Z" fill="${v.p}"/><path d="M69 42C64 38 62 36 66 40ZM83 42C88 38 90 36 86 40Z" fill="none"/><circle cx="74" cy="46" r="1" fill="${v.ink}"/><circle cx="78" cy="46" r="1" fill="${v.ink}"/><path d="M73.4 49Q76 51.4 78.6 49" fill="none" stroke="${v.ink}" stroke-width="1" stroke-linecap="round"/>${hand(v, 76, 62, 4.4)}`,
		),
	sword: (v) =>
		held(
			`<path class="glow" d="M76 20V76" stroke="#fff" stroke-width="8" stroke-linecap="round"/><path d="M76 17L80.4 24V76H71.6V24Z" fill="#e1e7f2" stroke="#9aa5ba" stroke-width="1.2" stroke-linejoin="round"/><path d="M76 24V74" stroke="#fff" stroke-width="1.4" opacity=".8"/><rect x="67" y="76" width="18" height="4" rx="2" fill="${v.t}"/><rect x="74.4" y="80" width="3.6" height="8" fill="${WOOD}"/><circle cx="76.2" cy="90" r="2.4" fill="${v.t}"/>${hand(v, 76.2, 83)}`,
		),
};
