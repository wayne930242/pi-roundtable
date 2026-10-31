import type { AvatarState, Expression } from "./catalog.ts";

type EyeShape =
	| "open"
	| "sparkle"
	| "wide"
	| "arc"
	| "closed"
	| "soft"
	| "narrow"
	| "xd"
	| "wink";
type MouthShape =
	| "smile"
	| "smileS"
	| "grin"
	| "o"
	| "flatR"
	| "firm"
	| "wobble"
	| "smirk"
	| "tongue"
	| "yawn"
	| "tilt";
/** The mouths that show an open mouth; the rest are a closed line. */
const OPEN_MOUTHS: ReadonlySet<MouthShape> = new Set([
	"grin",
	"o",
	"tongue",
	"yawn",
	"tilt",
]);

/** A talking figure's mouth for one frame: the expression's own when it already is open or closed, else an open "o" or a closed smile. */
function talking(shape: MouthShape, mouth: "open" | "closed"): MouthShape {
	const open = OPEN_MOUTHS.has(shape);
	if (mouth === "open") return open ? shape : "o";
	return open ? "smile" : shape;
}

type Extra = "blush" | "sweat" | "tear" | "sparkle" | "dots" | "burst";

interface ExpressionRow {
	eye: EyeShape;
	look: readonly [number, number];
	/** Left and right brow: [raise, tilt]; a tilt above 0 is the inner end down (angry), below 0 up (worried). */
	bl: readonly [number, number];
	br: readonly [number, number];
	mouth: MouthShape;
	fx: readonly Extra[];
	big?: 1;
}

const EXPRESSION_ROWS: Record<Expression, ExpressionRow> = {
	neutral: {
		eye: "open",
		look: [0, 0],
		bl: [0, 0],
		br: [0, 0],
		mouth: "smile",
		fx: [],
	},
	happy: {
		eye: "sparkle",
		look: [0, 0],
		bl: [-2, 0],
		br: [-2, 0],
		mouth: "grin",
		fx: ["blush"],
	},
	thinking: {
		eye: "open",
		look: [2.2, -2.4],
		bl: [-0.5, 0],
		br: [-4, -8],
		mouth: "flatR",
		fx: ["dots"],
	},
	concerned: {
		eye: "open",
		look: [0, 0.6],
		bl: [-1, -13],
		br: [-1, -13],
		mouth: "wobble",
		fx: [],
	},
	apologetic: {
		eye: "soft",
		look: [0, 0],
		bl: [-1, -20],
		br: [-1, -20],
		mouth: "wobble",
		fx: ["sweat", "blush"],
	},
	surprised: {
		eye: "wide",
		look: [0, 0],
		bl: [-4, -4],
		br: [-4, 4],
		mouth: "o",
		fx: ["burst"],
	},
	proud: {
		eye: "arc",
		look: [0, 0],
		bl: [-3, 0],
		br: [-3, 0],
		mouth: "smirk",
		fx: ["sparkle"],
	},
	amused: {
		eye: "xd",
		look: [0, 0],
		bl: [-2, 0],
		br: [-2, 0],
		mouth: "grin",
		fx: ["tear"],
	},
	curious: {
		eye: "open",
		look: [2.6, -0.4],
		bl: [-4, -6],
		br: [0, 0],
		mouth: "tilt",
		fx: [],
		big: 1,
	},
	sympathetic: {
		eye: "soft",
		look: [0, 1],
		bl: [-1, -10],
		br: [-1, -10],
		mouth: "smileS",
		fx: ["blush"],
	},
	playful: {
		eye: "wink",
		look: [0, 0],
		bl: [-3, -2],
		br: [1, 0],
		mouth: "tongue",
		fx: ["blush"],
	},
	determined: {
		eye: "narrow",
		look: [0, 0],
		bl: [1, 15],
		br: [1, 15],
		mouth: "firm",
		fx: [],
	},
	sleepy: {
		eye: "closed",
		look: [0, 0],
		bl: [2, 6],
		br: [2, 6],
		mouth: "yawn",
		fx: [],
	},
};

const f1 = (n: number): number => +n.toFixed(2);

/** Geometry of the chibi face (the lab's direction A). */
const FACE = {
	ex: [39, 61] as const,
	ey: 52,
	rx: 5.2,
	ry: 6.4,
	sw: 2.5,
	msw: 2.2,
	bl: 8.6,
	bw: 2.2,
	bdy: -9.8,
	mx: 50,
	my: 64,
	ms: 1,
	bx: 6.5,
	by: 8,
	br: 4,
	fx: [76, 40] as const,
	fs: 1,
	hw: 28,
	by0: 42,
};
const OVERLAY = {
	badge: [17, 19] as const,
	badgeR: 9.5,
	orbit: [50, 50, 45] as const,
	zz: [73, 28] as const,
};

/** Where the animation turns each part; characters.css carries them. */
export const PIVOTS = {
	eyes: `50px ${FACE.ey}px`,
	badge: `${OVERLAY.badge[0]}px ${OVERLAY.badge[1]}px`,
	orbit: `${OVERLAY.orbit[0]}px ${OVERLAY.orbit[1]}px`,
	character: "50px 94px",
} as const;

export const INK = "#2b2440";
const TONGUE = "#ef7b8a";

function eyeShape(shape: EyeShape, side: 0 | 1, ink: string): string {
	const { rx, ry, sw } = FACE;
	const open = (k = 1) =>
		`<ellipse rx="${f1(rx * k)}" ry="${f1(ry * k)}" fill="${ink}"/><circle cx="${f1(-rx * 0.3)}" cy="${f1(-ry * 0.36)}" r="${f1(rx * 0.4)}" fill="#fff"/><circle cx="${f1(rx * 0.38)}" cy="${f1(ry * 0.36)}" r="${f1(rx * 0.18)}" fill="#fff"/>`;
	const arc = `<path d="M${f1(-rx * 1.05)} ${f1(ry * 0.35)}Q0 ${f1(-ry * 1.15)} ${f1(rx * 1.05)} ${f1(ry * 0.35)}" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round"/>`;
	switch (shape) {
		case "open":
			return open();
		case "sparkle":
			return `${open(1.1)}<circle cx="${f1(-rx * 0.1)}" cy="${f1(ry * 0.5)}" r="${f1(rx * 0.14)}" fill="#fff" opacity=".8"/>`;
		case "wide":
			return `<circle r="${f1(ry * 1.12)}" fill="#fff" stroke="${ink}" stroke-width="${f1(sw * 0.7)}"/><circle r="${f1(ry * 0.5)}" fill="${ink}"/>`;
		case "arc":
			return arc;
		case "closed":
			return `<path d="M${f1(-rx)} ${f1(-ry * 0.1)}Q0 ${f1(ry * 0.85)} ${f1(rx)} ${f1(-ry * 0.1)}" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round"/>`;
		case "soft":
			return `<path d="M${f1(-rx)} ${f1(-ry * 0.25)}H${f1(rx)}A${f1(rx)} ${f1(ry * 1.05)} 0 0 1 ${f1(-rx)} ${f1(-ry * 0.25)}Z" fill="${ink}"/><circle cx="${f1(-rx * 0.25)}" cy="${f1(ry * 0.25)}" r="${f1(rx * 0.34)}" fill="#fff"/>`;
		case "narrow":
			return `<ellipse rx="${f1(rx * 0.98)}" ry="${f1(ry * 0.6)}" fill="${ink}"/><circle cx="${f1(-rx * 0.3)}" cy="${f1(-ry * 0.15)}" r="${f1(rx * 0.26)}" fill="#fff"/>`;
		case "xd": {
			const s = side ? -1 : 1;
			return `<path d="M${f1(-s * rx * 0.85)} ${f1(-ry * 0.75)}L${f1(s * rx * 0.6)} 0L${f1(-s * rx * 0.85)} ${f1(ry * 0.75)}" fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
		}
		case "wink":
			return side ? arc : open();
	}
}

function mouthShape(shape: MouthShape, ink: string): string {
	const stroke = `fill="none" stroke="${ink}" stroke-width="${FACE.msw}" stroke-linecap="round" stroke-linejoin="round"`;
	switch (shape) {
		case "smile":
			return `<path d="M-6 0Q0 5 6 0" ${stroke}/>`;
		case "smileS":
			return `<path d="M-4.2 0.4Q0 3.8 4.2 0.4" ${stroke}/>`;
		case "grin":
			return `<path d="M-7 -1Q0 3 7 -1Q5.5 8 0 8Q-5.5 8 -7 -1Z" fill="${ink}"/><ellipse cy="6.3" rx="2.9" ry="1.5" fill="${TONGUE}"/>`;
		case "o":
			return `<ellipse cy="3" rx="2.9" ry="3.5" fill="${ink}"/>`;
		case "flatR":
			return `<path d="M-3.5 2.4L4.5 0.4" ${stroke}/>`;
		case "firm":
			return `<path d="M-5 1.2H4.2L5.6 -0.4" ${stroke}/>`;
		case "wobble":
			return `<path d="M-6 3.2q1.5 -3 3 0t3 0t3 0t3 0" ${stroke}/>`;
		case "smirk":
			return `<path d="M-6 2.4Q0 4 6.4 -1.6" ${stroke}/>`;
		case "tongue":
			return `<path d="M-6.5 -0.5Q0 4.5 6.5 -0.5Z" fill="${ink}"/><path d="M-2.6 2.2Q0 10 2.8 2.4Z" fill="${TONGUE}"/>`;
		case "yawn":
			return `<ellipse cy="3.4" rx="3.4" ry="4.2" fill="${ink}"/><ellipse cy="5.6" rx="2" ry="1.4" fill="${TONGUE}"/>`;
		case "tilt":
			return `<ellipse cx="3" cy="2" rx="1.9" ry="2.4" fill="${ink}"/>`;
	}
}

export interface FaceColors {
	/** Eyes and mouth. */
	ink: string;
	/** Brows (hair mixed toward ink). */
	brow: string;
	/** The thinking dots and the burst (primary mixed toward ink). */
	dot: string;
}

export interface Face {
	eyes: string;
	brows: string;
	mouth: string;
	fx: string;
}

const star = (x: number, y: number, r: number, color: string): string =>
	`<path d="M${x} ${y - r}Q${x + r * 0.22} ${y - r * 0.22} ${x + r} ${y}Q${x + r * 0.22} ${y + r * 0.22} ${x} ${y + r}Q${x - r * 0.22} ${y + r * 0.22} ${x - r} ${y}Q${x - r * 0.22} ${y - r * 0.22} ${x} ${y - r}Z" fill="${color}"/>`;
const drop = (x: number, y: number, s: number, color: string): string =>
	`<path d="M${x} ${y - 3.6 * s}Q${x + 3 * s} ${y + 0.2 * s} ${x} ${y + 2.8 * s}Q${x - 3 * s} ${y + 0.2 * s} ${x} ${y - 3.6 * s}Z" fill="${color}"/>`;

export function faceParts(
	colors: FaceColors,
	expression: Expression,
	talk?: "open" | "closed",
): Face {
	const c = FACE;
	const row = EXPRESSION_ROWS[expression];
	const shape = talk === undefined ? row.mouth : talking(row.mouth, talk);
	const [lx, ly] = row.look;
	const eye = (cx: number, side: 0 | 1) => {
		const big = row.big && !side;
		return `<g transform="translate(${f1(cx + lx)} ${f1(c.ey + ly)})${big ? " scale(1.12)" : ""}">${eyeShape(row.eye, side, colors.ink)}</g>`;
	};
	const eyes = `<g class="eyes">${eye(c.ex[0], 0)}${eye(c.ex[1], 1)}</g>`;
	const brow = (
		cx: number,
		[dy, tilt]: readonly [number, number],
		side: 0 | 1,
	) =>
		`<path d="M${-c.bl / 2} 0H${c.bl / 2}" transform="translate(${cx} ${f1(c.ey + c.bdy + dy)}) rotate(${side ? -tilt : tilt})" stroke="${colors.brow}" stroke-width="${c.bw}" stroke-linecap="round" fill="none"/>`;
	const brows = `<g class="brows">${brow(c.ex[0], row.bl, 0)}${brow(c.ex[1], row.br, 1)}</g>`;
	const mouth = `<g class="mouth" transform="translate(${c.mx} ${c.my}) scale(${c.ms})">${mouthShape(shape, colors.ink)}</g>`;
	const [fx, fy] = c.fx;
	const blush = (cx: number) =>
		`<ellipse cx="${cx}" cy="${c.ey + c.by}" rx="${c.br}" ry="${f1(c.br * 0.62)}" fill="#ff7a8e" opacity=".5"/>`;
	const extra: Record<Extra, string> = {
		blush: blush(c.ex[0] - c.bx) + blush(c.ex[1] + c.bx),
		sweat: drop(fx, fy, c.fs, "#7fd0ff"),
		tear: drop(c.ex[1] + c.rx + 1.5, c.ey + c.ry * 0.9, c.fs * 0.8, "#7fd0ff"),
		sparkle:
			star(fx, fy - 1, 4.4 * c.fs, "#ffd84a") +
			star(fx + 5 * c.fs, fy + 5 * c.fs, 2 * c.fs, "#fff1a8"),
		dots: [1, 1.5, 2.1]
			.map(
				(r, i) =>
					`<circle cx="${f1(fx - 1 + i * 4.2 * c.fs)}" cy="${f1(fy - 2 - i * 3.6 * c.fs)}" r="${f1(r * c.fs)}" fill="${colors.dot}"/>`,
			)
			.join(""),
		burst: [-1, 1]
			.map(
				(s) =>
					`<path d="M${50 + s * (c.hw + 1)} ${c.by0 - 3}l${s * 4.5} -3M${50 + s * (c.hw + 2)} ${c.by0 + 3}l${s * 5.5} 0M${50 + s * (c.hw + 1)} ${c.by0 + 9}l${s * 4.5} 3" stroke="${colors.dot}" stroke-width="1.7" stroke-linecap="round"/>`,
			)
			.join(""),
	};
	return {
		eyes,
		brows,
		mouth,
		fx: `<g class="fx">${row.fx.map((name) => extra[name]).join("")}</g>`,
	};
}

/** Badge colors; the "!" "✓" and "×" are drawn paths, not text. */
export function overlays(
	primary: string,
	zzColor: string,
	only: AvatarState | null,
): string {
	const [bx, by] = OVERLAY.badge;
	const r = OVERLAY.badgeR;
	const k = r / 8;
	const disc = (cls: string, color: string, inner: string) =>
		`<g class="ov ${cls}"><circle cx="${bx}" cy="${by}" r="${r}" fill="${color}" stroke="#fff" stroke-width="1.6"/>${inner}</g>`;
	const wait = disc(
		"o-wait",
		"#f2a81d",
		`<path d="M${bx} ${by - 4.2 * k}V${by + 0.6 * k}" stroke="#fff" stroke-width="${f1(2.2 * k)}" stroke-linecap="round"/><circle cx="${bx}" cy="${f1(by + 3.6 * k)}" r="${f1(1.25 * k)}" fill="#fff"/>`,
	);
	const done = disc(
		"o-done",
		"#2fb36b",
		`<path d="M${f1(bx - 3.6 * k)} ${f1(by + 0.2 * k)}L${f1(bx - 1 * k)} ${f1(by + 3 * k)}L${f1(bx + 3.8 * k)} ${f1(by - 2.8 * k)}" fill="none" stroke="#fff" stroke-width="${f1(2.2 * k)}" stroke-linecap="round" stroke-linejoin="round"/>`,
	);
	const err = disc(
		"o-err",
		"#e5484d",
		`<path d="M${f1(bx - 3 * k)} ${f1(by - 3 * k)}L${f1(bx + 3 * k)} ${f1(by + 3 * k)}M${f1(bx + 3 * k)} ${f1(by - 3 * k)}L${f1(bx - 3 * k)} ${f1(by + 3 * k)}" stroke="#fff" stroke-width="${f1(2.2 * k)}" stroke-linecap="round"/>`,
	);
	const [ox, oy, orad] = OVERLAY.orbit;
	const orbit = `<g class="ov o-think"><circle cx="${ox}" cy="${f1(oy - orad)}" r="3.3" fill="${primary}" stroke="#fff" stroke-width="1.3"/></g>`;
	const [zx, zy] = OVERLAY.zz;
	const z = (x: number, y: number, w: number, sw: number) =>
		`<path d="M${x} ${y}H${x + w}L${x} ${y + w * 1.15}H${x + w}" fill="none" stroke="${zzColor}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
	const zz = `<g class="ov o-zz">${z(zx, zy, 7, 2.2)}${z(zx + 8, zy - 9, 5, 1.8)}</g>`;
	const pick: Partial<Record<AvatarState, string>> = {
		thinking: orbit,
		waiting: wait,
		done,
		error: err,
		sleepy: zz,
	};
	return `<g class="fg">${only ? (pick[only] ?? "") : orbit + wait + done + err + zz}</g>`;
}
