import { type Hall, hallOf, STATE_COLOR } from "./hall";
import { fitLabel } from "./label";
import { PLATE_FONT_STACK } from "./plate";
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
 * unchanged. State motion is CSS transform and opacity only (web/styles/table.css), and reduced
 * motion drops it.
 */

const NS = "http://www.w3.org/2000/svg";

const el = <K extends keyof SVGElementTagNameMap>(
	tag: K,
	attrs: Record<string, string | number> = {},
	parent?: Element,
) => {
	const e = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
	parent?.appendChild(e);
	return e;
};

const dataUri = (svg: string) => {
	const sized = /<svg[^>]*\swidth=/.test(svg)
		? svg
		: svg.replace("<svg", '<svg width="256" height="256"');
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
};

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
	const states = new Map<string, SeatState>();
	let focusId: string | null = opts.focus ?? null;

	const root = document.createElement("div");
	root.className = "t2d";
	const svg = el("svg", { role: "group", "aria-label": labels.table });
	root.appendChild(svg);
	if (getComputedStyle(container).position === "static")
		container.style.position = "relative";
	container.appendChild(root);

	/** The filter that cuts a figure out as a standee: a light rim and a dark line round it. */
	function rimFilter(defs: Element, hall: Hall, size: number) {
		const rim = Math.max(1.6, size * 0.022);
		const line = rim + Math.max(1.2, size * 0.014);
		const filter = el(
			"filter",
			{
				id: `${uid}-rim`,
				x: "-15%",
				y: "-15%",
				width: "130%",
				height: "130%",
			},
			defs,
		);
		el(
			"feMorphology",
			{ in: "SourceAlpha", operator: "dilate", radius: line, result: "far" },
			filter,
		);
		el("feFlood", { "flood-color": hall.ink, result: "ink" }, filter);
		el(
			"feComposite",
			{ in: "ink", in2: "far", operator: "in", result: "line" },
			filter,
		);
		el(
			"feMorphology",
			{ in: "SourceAlpha", operator: "dilate", radius: rim, result: "near" },
			filter,
		);
		el("feFlood", { "flood-color": hall.paper, result: "paper" }, filter);
		el(
			"feComposite",
			{ in: "paper", in2: "near", operator: "in", result: "rim" },
			filter,
		);
		const merge = el("feMerge", {}, filter);
		for (const node of ["line", "rim", "SourceGraphic"])
			el("feMergeNode", { in: node }, merge);
	}

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
		const pw = Math.max(46, Math.min(slotW * 0.94, 132, room * 1.05));
		const ph = pw * 0.72;
		const figure = pw * 1.05;
		rimFilter(defs, hall, figure);
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
		seats.forEach((s, i) => {
			const row = Math.floor(i / perRow);
			const inRow = Math.min(perRow, n - row * perRow);
			const col = i - row * perRow;
			const x = (W / inRow) * (col + 0.5);
			const y = rowY(row);
			const st = states.get(s.id) ?? "idle";
			const g = el(
				"g",
				{
					class: "seat",
					"data-state": st,
					...(focusId === s.id ? { "data-focus": "" } : {}),
					transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})`,
					tabindex: opts.listBelow ? -1 : 0,
					role: "button",
					"aria-label": labels.seat(s.name, st),
					color: hall.css.text,
					...(opts.listBelow ? { "aria-hidden": "true" } : {}),
				},
				svg,
			);
			el(
				"ellipse",
				{
					cx: 0,
					cy: 3,
					rx: pw * 0.55,
					ry: pw * 0.1,
					fill: "#000",
					opacity: 0.35,
				},
				g,
			);
			el(
				"ellipse",
				{
					class: "halo",
					cx: 0,
					cy: -ph - figure * 0.35,
					rx: figure * 0.8,
					ry: figure * 0.8,
					fill: `url(#${uid}-h${i})`,
				},
				g,
			);
			el(
				"polygon",
				{
					class: "beam",
					points: `${-figure * 0.12},${-figure * 2.1} ${figure * 0.12},${-figure * 2.1} ${figure * 0.5},0 ${-figure * 0.5},0`,
					fill: s.color,
					opacity: 0.2,
				},
				g,
			);
			const lift = el("g", { class: "lift" }, g);
			const picture = svgs.get(s.id);
			if (picture) {
				el(
					"image",
					{
						href: dataUri(picture),
						x: -figure / 2,
						y: -ph - figure * 0.78,
						width: figure,
						height: figure * 0.88,
						filter: `url(#${uid}-rim)`,
						...(s.dim ? { opacity: 0.55 } : {}),
					},
					lift,
				);
			} else {
				el(
					"circle",
					{
						cx: 0,
						cy: -ph - figure * 0.3,
						r: figure * 0.3,
						fill: s.color,
						stroke: hall.ink,
						"stroke-width": 2,
					},
					lift,
				);
				const t = el(
					"text",
					{
						x: 0,
						y: -ph - figure * 0.3 + figure * 0.1,
						"text-anchor": "middle",
						"font-size": figure * 0.3,
						"font-weight": 700,
						fill: "#fff",
						"font-family": PLATE_FONT_STACK,
					},
					lift,
				);
				t.textContent = Array.from(s.name)[0]?.toUpperCase() ?? "?";
			}
			// the podium in front of the figure: a desk top, a body and the gold plate
			const top = ph * 0.22;
			el(
				"path",
				{
					d: `M ${-pw * 0.5} ${-ph} L ${pw * 0.5} ${-ph} L ${pw * 0.42} 0 L ${-pw * 0.42} 0 Z`,
					fill: hall.wood,
					stroke: hall.ink,
					"stroke-width": 2,
					"stroke-linejoin": "round",
				},
				g,
			);
			el(
				"rect",
				{
					x: -pw * 0.54,
					y: -ph - top * 0.2,
					width: pw * 1.08,
					height: top,
					rx: 2,
					fill: hall.woodLight,
					stroke: hall.ink,
					"stroke-width": 2,
				},
				g,
			);
			const fs = Math.max(11, Math.min(15, pw * 0.14));
			// room for about eight Latin letters even on a small seat, so a short name is never cut
			const plateW = Math.min(
				Math.max(pw * 0.9, fs * 5.5 + 14),
				Math.max(pw * 0.9, s.name.length * fs * 0.62 + 18),
				slotW * 0.98,
			);
			const plateH = fs + 8;
			el(
				"rect",
				{
					class: "plate",
					x: -plateW / 2,
					y: -ph * 0.78,
					width: plateW,
					height: plateH,
					rx: 3,
					fill: hall.gold,
					stroke: hall.ink,
					"stroke-width": 2,
				},
				g,
			);
			const label = el(
				"text",
				{
					x: 0,
					y: -ph * 0.78 + fs + 1.5,
					"text-anchor": "middle",
					"font-size": fs,
					"font-weight": 700,
					"font-family": PLATE_FONT_STACK,
					fill: hall.plateInk,
				},
				g,
			);
			label.textContent = fitLabel(s.name, (plateW - 8) / fs);
			// badges
			const badge = el(
				"g",
				{ class: "badge" },
				el(
					"g",
					{ transform: `translate(${figure * 0.4} ${-ph - figure * 0.78})` },
					g,
				),
			);
			const isDone = st === "done";
			const isErr = st === "error";
			let badgeFill: string = hall.gold;
			if (isDone) badgeFill = STATE_COLOR.done;
			else if (isErr) badgeFill = STATE_COLOR.error;
			el(
				"circle",
				{
					r: figure * 0.15,
					fill: badgeFill,
					stroke: hall.ink,
					"stroke-width": 2,
				},
				badge,
			);
			const glyph = el(
				"text",
				{
					x: 0,
					y: figure * 0.06,
					"text-anchor": "middle",
					"font-size": figure * 0.2,
					"font-weight": 800,
					"font-family": PLATE_FONT_STACK,
					fill: isDone || isErr ? "#fff" : hall.ink,
				},
				badge,
			);
			glyph.textContent = "!";
			if (isDone) glyph.textContent = "✓";
			else if (isErr) glyph.textContent = "✕";
			// thinking mote
			const orbit = el("g", { class: "orbit" }, g);
			el(
				"circle",
				{
					cx: figure * 0.4,
					cy: -ph - figure * 0.5,
					r: figure * 0.05,
					fill: s.color,
				},
				orbit,
			);
			el(
				"circle",
				{
					cx: -figure * 0.4,
					cy: -ph - figure * 0.5,
					r: figure * 0.035,
					fill: s.color,
					opacity: 0.6,
				},
				orbit,
			);
			g.addEventListener("click", () =>
				opts.onSeatClick({ id: s.id, name: s.name }),
			);
			g.addEventListener("keydown", (e) => {
				if (
					(e as KeyboardEvent).key === "Enter" ||
					(e as KeyboardEvent).key === " "
				) {
					e.preventDefault();
					opts.onSeatClick({ id: s.id, name: s.name });
				}
			});
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
			seats = list;
			for (const s of list) {
				states.set(s.id, s.state ?? "idle");
				if (s.avatarSvg) svgs.set(s.id, s.avatarSvg);
			}
			draw();
		},
		setState(id, state) {
			if (states.get(id) === state) return;
			states.set(id, state);
			draw();
		},
		setAvatar(id, s) {
			svgs.set(id, s);
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
			ro.disconnect();
			mq.removeEventListener("change", onMq);
			root.remove();
		},
	};
	api.setSeats(opts.seats);
	return api;
}
