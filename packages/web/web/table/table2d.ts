import { hallOf } from "./hall";
import { fitLabel } from "./label";
import { PLATE_FONT_STACK } from "./plate";
import { planSeating } from "./seating";
import { drawSeat, type SeatScene } from "./table2d-seat";
import { showChange } from "./table2d-show";
import { el, rimFilter } from "./table2d-svg";
import type {
	Scheme,
	SeatInit,
	SeatState,
	TableHandle,
	TableOptions,
	TableStats,
	ThemeName,
} from "./types";
import { ENGLISH_TABLE_LABELS } from "./types";

/**
 * The 2D council hall: the same ring of podiums with standees behind them, drawn as SVG in the hall's
 * palette, for a browser without WebGL, a lost context, and the compact strip. It has the scene's
 * own contract (seats, states, focus, a click on a seat), so the page's dialogue box works over it
 * unchanged. State motion is CSS transform and opacity only (web/styles/table.css), a speaker's
 * mouth is its open-mouthed picture shown in discrete frames over the closed one, and reduced motion
 * drops both.
 */

/** Counts tables, so the ids one table's filters carry are not the next table's: two tables share a page (the strip and the scene). */
let tables = 0;

/** How the podiums are laid out: how many rows, and how many in each. */
export function layoutOf(
	count: number,
	compact: boolean,
): { rows: number; perRow: number } {
	const rows = compact || count <= 6 ? 1 : 2;
	return { rows, perRow: Math.max(1, Math.ceil(count / rows)) };
}

export function createTable2D(
	container: HTMLElement,
	opts: TableOptions,
): TableHandle {
	const uid = `t2d${++tables}`;
	const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
	let reduced =
		opts.reducedMotion === "auto" || opts.reducedMotion === undefined
			? mq.matches
			: opts.reducedMotion;
	const labels = opts.labels ?? ENGLISH_TABLE_LABELS;
	let theme: ThemeName = opts.theme;
	let scheme: Scheme = opts.scheme;
	let seats: SeatInit[] = [];
	const svgs = new Map<string, string>();
	/** Each seat's open-mouthed picture, while it has one. */
	const talks = new Map<string, string>();
	const states = new Map<string, SeatState>();
	const marks = new Map<string, string>();
	let focusId: string | null = opts.focus ?? null;

	const root = document.createElement("div");
	root.className = "t2d";
	const svg = el("svg", { role: "group", "aria-label": labels.table });
	root.appendChild(svg);
	if (getComputedStyle(container).position === "static")
		container.style.position = "relative";
	container.appendChild(root);

	/** The filter that cuts a figure out as a standee: a light rim and a dark line round it. */
	function draw() {
		const hall = hallOf(theme, scheme);
		root.classList.toggle("reduced", reduced);
		root.classList.toggle("focus", focusId !== null);
		root.classList.toggle(
			"dim",
			seats.some((s) => states.get(s.id) === "speaking"),
		);
		const compact = opts.variant === "compact";
		const W = Math.max(container.clientWidth, 200);
		const H = Math.max(container.clientHeight, compact ? 60 : 200);
		svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
		svg.replaceChildren();
		const n = Math.max(seats.length, 1);
		const { rows, perRow } = layoutOf(n, compact);

		el("rect", { width: W, height: H, fill: hall.css.bg }, svg);
		const defs = el("defs", {}, svg);
		// the floor and the rune circle
		const cx = W / 2;
		const floorY = compact ? H * 0.82 : H * 0.62;
		el(
			"ellipse",
			{
				cx,
				cy: floorY,
				rx: W * 0.47,
				ry: compact ? H * 0.2 : H * 0.34,
				fill: hall.css.floor,
				stroke: hall.ink,
				"stroke-width": 2,
			},
			svg,
		);
		if (!compact)
			el(
				"ellipse",
				{
					cx,
					cy: floorY,
					rx: W * 0.3,
					ry: H * 0.2,
					fill: "none",
					stroke: hall.css.ring,
					"stroke-width": 3,
					opacity: hall.night ? 0.9 : 0.7,
				},
				svg,
			);

		const slotW = W / perRow;
		const room = compact ? H * 0.95 : H / (rows + 0.6);
		// A compact figure stands 1.54 podium widths above its foot (0.92 H): the width keeps the whole head in the strip.
		const fits = compact ? (H * 0.92 - 6) / 1.54 : 132;
		const pw = Math.max(46, Math.min(slotW * 0.94, 132, room * 1.05, fits));
		const ph = pw * 0.72;
		const figure = pw * 1.05;
		rimFilter(uid, defs, hall, figure);
		seats.forEach((s2, i) => {
			const rg = el("radialGradient", { id: `${uid}-h${i}` }, defs);
			el(
				"stop",
				{ offset: 0, "stop-color": s2.color, "stop-opacity": 0.95 },
				rg,
			);
			el("stop", { offset: 1, "stop-color": s2.color, "stop-opacity": 0 }, rg);
		});

		const rowY = (row: number) => {
			if (compact) return H * 0.92;
			return rows === 1 ? H * 0.62 : H * (0.46 + row * 0.3);
		};
		const scene: SeatScene = {
			svg,
			hall,
			uid,
			opts,
			labels,
			states,
			svgs,
			talks,
			marks,
			reduced,
			focusId,
			pw,
			ph,
			figure,
			slotW,
		};
		seats.forEach((s, i) => {
			const row = Math.floor(i / perRow);
			const inRow = Math.min(perRow, n - row * perRow);
			const col = i - row * perRow;
			drawSeat(scene, s, i, (W / inRow) * (col + 0.5), rowY(row));
		});
		if (!compact) {
			// the owner's own place: a low desk at the near edge
			const ow = Math.min(W * 0.34, 190);
			const oy = H - 6;
			el(
				"rect",
				{
					x: cx - ow / 2,
					y: oy - 22,
					width: ow,
					height: 22,
					rx: 4,
					fill: hall.wood,
					stroke: hall.ink,
					"stroke-width": 2,
				},
				svg,
			);
			const you = el(
				"text",
				{
					x: cx,
					y: oy - 7,
					"text-anchor": "middle",
					"font-size": 12,
					"font-weight": 700,
					"font-family": PLATE_FONT_STACK,
					fill: hall.gold,
				},
				svg,
			);
			you.textContent = fitLabel(opts.ownerName ?? "You", 12);
		}
	}

	/** The pieces of a show that are in the picture only for a while. */
	/** The pieces of a show that are in the picture only for a while. */
	const ephemera = new Set<ReturnType<typeof setTimeout>>();

	const ro = new ResizeObserver(draw);
	ro.observe(container);
	const onMq = () => {
		if (opts.reducedMotion === "auto" || opts.reducedMotion === undefined)
			api.setReducedMotion(mq.matches);
	};
	mq.addEventListener("change", onMq);

	const api: TableHandle = {
		kind: "svg",
		setTheme(t, s) {
			theme = t;
			scheme = s;
			draw();
		},
		setSeats(list) {
			const before = seats.map((s) => s.id);
			const standing = new Map(
				[...svg.querySelectorAll<SVGGElement>("g.seat[data-seat]")].map((g) => [
					g.getAttribute("data-seat") ?? "",
					g,
				]),
			);
			seats = list;
			for (const s of list) {
				states.set(s.id, s.state ?? "idle");
				if (s.avatarSvg) svgs.set(s.id, s.avatarSvg);
				if (s.talkSvg) talks.set(s.id, s.talkSvg);
				else talks.delete(s.id);
			}
			draw();
			// the first seats are not an arrival; a change of who sits plays a short show in CSS
			if (before.length > 0 || standing.size > 0)
				showChange(
					svg,
					hallOf(theme, scheme),
					ephemera,
					planSeating(
						before,
						list.map((s) => s.id),
						reduced,
					),
					standing,
				);
		},
		setState(id, state) {
			if (states.get(id) === state) return;
			states.set(id, state);
			draw();
		},
		setMark(id, mark) {
			if ((marks.get(id) ?? null) === mark) return;
			if (mark === null) marks.delete(id);
			else marks.set(id, mark);
			draw();
		},
		setAvatar(id, s, talk) {
			svgs.set(id, s);
			if (talk) talks.set(id, talk);
			else talks.delete(id);
			draw();
			return Promise.resolve();
		},
		setReducedMotion(r) {
			reduced = r;
			draw();
		},
		resetCamera() {
			focusId = null;
			draw();
			opts.onFocus?.(null);
		},
		focus(id) {
			if (id === focusId) return;
			focusId = id;
			draw();
		},
		focused: () => focusId,
		getStats(): TableStats {
			return {
				kind: "svg",
				fps: 0,
				frameMs: 0,
				frameMsMax: 0,
				drawCalls: 0,
				triangles: 0,
				textures: 0,
				geometries: 0,
				dpr: 1,
				lowPower: false,
				reduced,
				loop: "idle",
				seats: seats.length,
				renders: 0,
			};
		},
		dispose() {
			for (const timer of ephemera) clearTimeout(timer);
			ephemera.clear();
			ro.disconnect();
			mq.removeEventListener("change", onMq);
			root.remove();
		},
	};
	api.setSeats(opts.seats);
	return api;
}
