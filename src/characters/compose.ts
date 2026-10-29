import {
	AVATAR_STATES,
	type AvatarState,
	CATALOG,
	EXPRESSIONS,
	type Expression,
	STATE_EXPRESSION,
} from "./catalog.ts";
import { accentColor, darken, lighten, mix, type Tones } from "./colors.ts";
import { parseCharacter } from "./parse.ts";
import { faceParts, INK, overlays } from "./parts-face.ts";
import { ACCESSORIES, BEARDS, HAIR } from "./parts-hair.ts";
import { HATS } from "./parts-hats.ts";
import { OUTFITS } from "./parts-outfits.ts";
import { PROPS } from "./parts-props.ts";
import { checkSkins } from "./skins.ts";
import {
	CharacterError,
	type CharacterSpec,
	checkOneOf,
	type Hex,
} from "./spec.ts";

export type CharacterLook =
	| "modern-light"
	| "modern-dark"
	| "camelot-light"
	| "camelot-dark";

export interface ComposeOptions {
	/** Default `STATE_EXPRESSION[state ?? "idle"]`. */
	expr?: Expression;
	/** With `still`: which overlay is baked in. Live output carries every overlay. */
	state?: AvatarState;
	/** Background and ring only. Default `"modern-light"`. */
	look?: CharacterLook;
	/** Default `"disc"`. */
	frame?: "disc" | "shield";
	/** No frame and no background. */
	bare?: boolean;
	/** For files, PNG and 3D: only the active state's overlay, and no motion needed. */
	still?: boolean;
	/** `/^[a-z0-9]{1,16}$/`, the suffix of the clip path ids. Default `"a"`. */
	uid?: string;
	/** Adds `width` and `height` (the PNG rasterizer needs them). */
	size?: number;
	/** The accessible name, escaped into `aria-label`; without it the figure is `aria-hidden`. */
	label?: string;
	/**
	 * Six `#rrggbb` skin tones that `CharacterSpec.skin` indexes, in place of `CATALOG.skins`; a
	 * host's own set, such as `EAST_ASIAN_SKINS`. Anything but six valid colors throws.
	 */
	skins?: readonly Hex[] | undefined;
}

const LOOKS = ["modern-light", "modern-dark", "camelot-light", "camelot-dark"];
const FRAMES = ["disc", "shield"] as const;
const UID = /^[a-z0-9]{1,16}$/;
const MAX_LABEL = 200;
const MAX_SIZE = 4096;

interface LookStyle {
	bg: (primary: string) => string;
	ring: (primary: string) => string;
	width: number;
	/** The thin inner line of the Camelot frame. */
	line: string | null;
}

const STYLES: Record<CharacterLook, LookStyle> = {
	"modern-light": {
		bg: (p) => lighten(p, 0.8),
		ring: (p) => p,
		width: 3,
		line: null,
	},
	"modern-dark": {
		bg: (p) => mix(p, "#0d1018", 0.68),
		ring: (p) => lighten(p, 0.15),
		width: 3,
		line: null,
	},
	"camelot-light": {
		bg: (p) => mix("#f2e6c6", p, 0.1),
		ring: () => "#b98a2c",
		width: 4.2,
		line: "#8a5f12",
	},
	"camelot-dark": {
		bg: (p) => mix("#16224c", p, 0.16),
		ring: () => "#e6b94c",
		width: 4.2,
		line: "#ffe08a",
	},
};

const SHIELD = "M12 14H88V50Q88 78 50 97Q12 78 12 50Z";
const ERROR_RED = "#e5484d";

/**
 * Text safe inside a double-quoted attribute and inert as markup or script: the characters that
 * open a tag, end a value or start a call become entities, which also leaves no `on…=`, `style=`
 * or `var(` in the output, and `href` is broken by one more entity.
 */
function escapeAttribute(text: string): string {
	return text
		.replace(/[&<>"'=()]/g, (char) => `&#${char.charCodeAt(0)};`)
		.replace(
			/href/gi,
			(word) => `${word[0]}&#${word.charCodeAt(1)};${word.slice(2)}`,
		);
}

function tonesOf(
	spec: CharacterSpec,
	look: LookStyle,
	error: boolean,
	skins: readonly Hex[],
) {
	const { primary, secondary, trim } = spec.colors;
	const skin = skins[spec.skin] as Hex;
	const tones: Tones = {
		p: primary,
		pd: darken(primary, 0.3),
		pl: lighten(primary, 0.35),
		pll: lighten(primary, 0.65),
		s: secondary,
		sd: darken(secondary, 0.16),
		t: trim,
		td: darken(trim, 0.3),
		k: skin,
		kd: darken(skin, 0.12),
		hr: spec.hairColor,
		hd: darken(spec.hairColor, 0.2),
		ink: INK,
		gl: lighten(primary, 0.5),
	};
	return {
		tones,
		bg: look.bg(primary),
		ring: error ? ERROR_RED : look.ring(primary),
	};
}

function group(name: string, inner: string, extra = ""): string {
	return inner
		? `<g class="${name}" data-part="${name}"${extra}>${inner}</g>`
		: "";
}

/**
 * The figure as an SVG string with literal colors: no style attribute, variable, script or
 * link, so it is safe to inject into a page that forbids inline styles and renders the same
 * through canvas or a 3D texture. The spec is checked again here, so a spec cast from untrusted
 * data cannot reach the markup. State motion is in `characters.css`.
 */
export function composeSvg(
	spec: CharacterSpec,
	options: ComposeOptions = {},
): string {
	const s = parseCharacter(spec);
	const state =
		options.state === undefined
			? undefined
			: checkOneOf(AVATAR_STATES, options.state, "state");
	const expr = checkOneOf(
		EXPRESSIONS,
		options.expr ?? STATE_EXPRESSION[state ?? "idle"],
		"expr",
	);
	const lookName = checkOneOf(
		LOOKS,
		options.look ?? "modern-light",
		"look",
	) as CharacterLook;
	const frame = checkOneOf(FRAMES, options.frame ?? "disc", "frame");
	const uid = options.uid ?? "a";
	if (typeof uid !== "string" || !UID.test(uid))
		throw new CharacterError("uid", "must match /^[a-z0-9]{1,16}$/");
	const { size, label } = options;
	if (
		size !== undefined &&
		!(Number.isInteger(size) && size >= 1 && size <= MAX_SIZE)
	)
		throw new CharacterError("size", `must be an integer up to ${MAX_SIZE}`);
	if (
		label !== undefined &&
		(typeof label !== "string" || label.length > MAX_LABEL)
	)
		throw new CharacterError(
			"label",
			`must be text of at most ${MAX_LABEL} characters`,
		);
	const skins =
		options.skins === undefined
			? CATALOG.skins
			: checkSkins(options.skins, "skins");
	const bare = options.bare === true;
	const still = options.still === true;

	const style = STYLES[lookName];
	const { tones, bg, ring } = tonesOf(s, style, state === "error", skins);
	const face = faceParts(
		{ ink: INK, brow: mix(s.hairColor, INK, 0.5), dot: mix(tones.p, INK, 0.1) },
		expr,
	);

	const hair = HAIR[s.hair](tones);
	const hood =
		s.hat === "hood"
			? `<path d="M17 62C12 22 88 22 83 62C81 72 72 77 66 78H34C28 77 19 72 17 62Z" fill="${tones.pd}"/>`
			: "";
	const outfit = OUTFITS[s.outfit](tones);
	const factor = { slim: 0.8, regular: 1, stout: 1.3 }[s.build];
	const dressed =
		factor === 1
			? outfit
			: `<g transform="translate(${+(50 - 50 * factor).toFixed(2)} 0) scale(${factor} 1)">${outfit}</g>`;
	let body = dressed;
	if (!bare)
		body =
			frame === "shield"
				? `<g clip-path="url(#as${uid})">${dressed}</g>`
				: `<clipPath id="ad${uid}"><circle cx="50" cy="50" r="44.6"/></clipPath><g clip-path="url(#ad${uid})">${dressed}</g>`;

	const line = style.line;
	const frameMarkup =
		frame === "shield"
			? `<clipPath id="as${uid}"><path d="${SHIELD}"/></clipPath><path d="${SHIELD}" fill="${bg}" stroke="${ring}" stroke-width="${style.width}" stroke-linejoin="round" class="ring"/>${
					line
						? `<path d="M16.5 18.5H83.5V50Q83.5 74 50 91.6Q16.5 74 16.5 50Z" fill="none" stroke="${line}" stroke-width=".9" opacity=".55"/>`
						: ""
				}`
			: `<circle cx="50" cy="50" r="46.4" fill="${bg}" stroke="${ring}" stroke-width="${style.width}" class="ring"/>${
					line
						? `<circle cx="50" cy="50" r="40.6" fill="none" stroke="${line}" stroke-width=".9" opacity=".55"/>`
						: ""
				}<ellipse cx="50" cy="93" rx="19" ry="2.6" fill="#000" opacity=".12"/>`;

	const head =
		`<circle cx="22.6" cy="54" r="4.2" fill="${tones.k}"/><circle cx="77.4" cy="54" r="4.2" fill="${tones.k}"/>` +
		`<ellipse cx="50" cy="51" rx="28" ry="26" fill="${tones.k}"/><path d="M23 58Q50 88 77 58Q77 76 50 77Q23 76 23 58Z" fill="${tones.kd}" opacity=".3"/>` +
		`<ellipse cx="50" cy="58.4" rx="1.7" ry="1.2" fill="${tones.kd}"/>` +
		hair.front +
		(s.beard === "none" ? "" : BEARDS[s.beard](tones));

	const inner =
		(bare ? "" : group("frame", frameMarkup)) +
		`<g class="ch">` +
		group("back", hair.back + hood) +
		group("body", body) +
		group("head", head) +
		group("hat", HATS[s.hat](tones)) +
		group("eyes-brows", face.eyes + face.brows) +
		group("mouth", face.mouth) +
		group("fx", face.fx) +
		group(
			"acc",
			s.accessory === "none" ? "" : ACCESSORIES[s.accessory](tones),
		) +
		group("prop", PROPS[s.prop](tones), ` data-prop="${s.prop}"`) +
		`</g>` +
		group(
			"state",
			overlays(tones.p, darken(tones.p, 0.1), still ? (state ?? "idle") : null),
		);

	const attributes = [
		`xmlns="http://www.w3.org/2000/svg"`,
		`viewBox="0 0 100 100"`,
		size === undefined ? "" : `width="${size}" height="${size}"`,
		`class="${still ? "av static" : "av"}"`,
		state === undefined && !still ? "" : `data-state="${state ?? "idle"}"`,
		`data-expr="${expr}"`,
		label === undefined
			? `aria-hidden="true"`
			: `role="img" aria-label="${escapeAttribute(label)}"`,
	]
		.filter(Boolean)
		.join(" ");
	return `<svg ${attributes}>${inner}</svg>`.replace(
		/class="glow"/g,
		`class="glow" opacity=".3"`,
	);
}

/**
 * The agent's accent as a UI color: `colors.primary`, shaded until it reads at 3:1 on the page. A
 * scheme means the modern page; a look (`camelot-light`) means that look's hardest surface.
 */
export function accentOf(
	spec: CharacterSpec,
	on: "light" | "dark" | CharacterLook,
): Hex {
	return accentColor(spec.colors.primary, on);
}
