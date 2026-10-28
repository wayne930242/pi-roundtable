import { fitLabel } from "./label";
import { palette, STATE_COLOR } from "./themes";
import type {
	Scheme,
	SeatInit,
	SeatState,
	TableHandle,
	TableOptions,
	TableStats,
	ThemeName,
} from "./types";

/** 2D SVG round table: same contract as the WebGL view. State motion is CSS transform/opacity only (web/styles/table.css), and reduced-motion drops it. */

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

/** Counts tables, so the ids one table's gradients carry are not the next table's: two tables share a page (the strip and the panel). */
let tables = 0;

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
	let theme: ThemeName = opts.theme;
	let scheme: Scheme = opts.scheme;
	let seats: SeatInit[] = [];
	const svgs = new Map<string, string>();
	const states = new Map<string, SeatState>();

	const root = document.createElement("div");
	root.className = "t2d";
	const svg = el("svg", { role: "group", "aria-label": "Round table" });
	root.appendChild(svg);
	if (getComputedStyle(container).position === "static")
		container.style.position = "relative";
	container.appendChild(root);

	function draw() {
		const pal = palette(theme, scheme);
		root.classList.toggle("reduced", reduced);
		root.classList.toggle(
			"dim",
			seats.some((s) => states.get(s.id) === "speaking"),
		);
		const W = Math.max(container.clientWidth, 200);
		const H = Math.max(
			container.clientHeight,
			opts.variant === "compact" ? 60 : 200,
		);
		svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
		svg.replaceChildren();
		const n = Math.max(seats.length, 1);
		const portrait = W / H < 0.8;
		const cx = W / 2;
		const cy = H / 2;
		const av = Math.max(
			44,
			Math.min(
				96,
				Math.min(W, H) *
					(n > 8 ? 0.13 : n > 6 ? 0.15 : 0.19) *
					(portrait ? 1.1 : 1),
			),
		);
		const Ry = Math.min(H / 2 - av * 1.15, portrait ? W * 0.5 : H);
		const Rx = Math.min(W / 2 - av * 0.65, portrait ? W : Ry * 1.75);
		const tx = Math.max(Rx - av * 0.85, 30);
		const ty = Math.max(Ry - av * 0.8, 24);

		el("rect", { width: W, height: H, fill: pal.bg }, svg);
		const defs = el("defs", {}, svg);
		const fl = el("radialGradient", { id: `${uid}-floor` }, defs);
		el("stop", { offset: 0, "stop-color": pal.rug }, fl);
		el("stop", { offset: 0.9, "stop-color": pal.rug }, fl);
		el("stop", { offset: 1, "stop-color": pal.rugEdge }, fl);
		el(
			"ellipse",
			{
				cx,
				cy: cy + 10,
				rx: Rx + av * 0.75,
				ry: Ry + av * 0.5,
				fill: `url(#${uid}-floor)`,
			},
			svg,
		);
		el(
			"ellipse",
			{
				cx,
				cy: cy + 16,
				rx: tx * 1.05,
				ry: ty * 1.1,
				fill: "#000",
				opacity: pal.shadow * 0.45,
			},
			svg,
		);
		el("ellipse", { cx, cy: cy + 9, rx: tx, ry: ty, fill: pal.rim }, svg);
		el("ellipse", { cx, cy, rx: tx, ry: ty, fill: pal.table }, svg);
		el(
			"ellipse",
			{
				cx,
				cy,
				rx: tx * 0.5,
				ry: ty * 0.5,
				fill: "none",
				stroke: pal.inlay,
				"stroke-width": 2,
				opacity: 0.7,
				"stroke-dasharray": pal.candles ? "5 4" : "0",
			},
			svg,
		);
		if (pal.candles)
			el("circle", { cx, cy: cy - 4, r: 5, fill: pal.flame }, svg);
		seats.forEach((s2, i) => {
			const gid = `${uid}-h${i}`;
			const rg = el("radialGradient", { id: gid }, defs);
			el(
				"stop",
				{ offset: 0, "stop-color": s2.color, "stop-opacity": 0.95 },
				rg,
			);
			el("stop", { offset: 1, "stop-color": s2.color, "stop-opacity": 0 }, rg);
		});

		const compact = opts.variant === "compact";
		const placed = compact
			? seats.map((s, i) => {
					const slot = W / n;
					const size = Math.min(H * 0.62, slot * 0.82);
					return { s, x: slot * (i + 0.5), y: H * 0.7, size, a: 0 };
				})
			: seats
					.map((s, i) => ({ s, a: Math.PI + (i / n) * Math.PI * 2 }))
					.sort((p, q) => Math.cos(p.a) - Math.cos(q.a))
					.map(({ s, a }) => {
						const depth = 0.9 + 0.1 * Math.cos(a);
						return {
							s,
							a,
							x: cx + Math.sin(a) * Rx,
							y: cy + Math.cos(a) * Ry + av * 0.22,
							size: av * depth,
						};
					});
		for (const { s, x, y, size } of placed) {
			const st = states.get(s.id) ?? "idle";
			const g = el(
				"g",
				{
					class: "seat",
					"data-state": st,
					transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})`,
					tabindex: opts.listBelow ? -1 : 0,
					role: "button",
					"aria-label": `${s.name} (${st})`,
					color: pal.css.text,
					...(opts.listBelow ? { "aria-hidden": "true" } : {}),
				},
				svg,
			);
			el(
				"ellipse",
				{
					cx: 0,
					cy: 4,
					rx: size * 0.55,
					ry: size * 0.16,
					fill: "#000",
					opacity: pal.shadow * 0.6,
				},
				g,
			);
			el(
				"ellipse",
				{
					class: "halo",
					cx: 0,
					cy: -size * 0.5,
					rx: size * 0.85,
					ry: size * 0.85,
					fill: `url(#${uid}-h${seats.indexOf(s)})`,
				},
				g,
			);
			const beam = el(
				"polygon",
				{
					class: "beam",
					points: `${-size * 0.12},${-size * 2.1} ${size * 0.12},${-size * 2.1} ${size * 0.5},0 ${-size * 0.5},0`,
					fill: s.color,
					opacity: 0.22,
				},
				g,
			);
			void beam;
			const lift = el("g", { class: "lift" }, g);
			const img = el(
				"image",
				{
					href: svgs.has(s.id) ? dataUri(svgs.get(s.id)!) : "",
					x: -size / 2,
					y: -size,
					width: size,
					height: size,
				},
				lift,
			);
			if (!svgs.has(s.id)) {
				img.remove();
				el(
					"circle",
					{ cx: 0, cy: -size / 2, r: size * 0.36, fill: s.color },
					lift,
				);
				const t = el(
					"text",
					{
						x: 0,
						y: -size / 2 + size * 0.12,
						"text-anchor": "middle",
						"font-size": size * 0.36,
						"font-weight": 700,
						fill: "#fff",
					},
					lift,
				);
				t.textContent = s.name.slice(0, 1).toUpperCase();
			}
			const fs = Math.max(11, Math.min(15, size * 0.2));
			// Room for about eight Latin letters even on a small seat, so a short name is never cut.
			const pw = Math.min(
				Math.max(size * 1.5, fs * 5.5 + 14),
				Math.max(size * 0.9, s.name.length * fs * 0.62 + 18),
			);
			el(
				"rect",
				{
					class: "plate",
					x: -pw / 2,
					y: 2,
					width: pw,
					height: fs + 12,
					rx: 7,
					fill: pal.css.plate,
					stroke: "none",
				},
				g,
			);
			el(
				"rect",
				{
					x: -pw / 2,
					y: 2 + fs + 7,
					width: pw,
					height: 5,
					rx: 2.5,
					fill: s.color,
				},
				g,
			);
			const label = el(
				"text",
				{
					x: 0,
					y: 2 + fs + 1,
					"text-anchor": "middle",
					"font-size": fs,
					"font-weight": 700,
					fill: pal.css.text,
				},
				g,
			);
			// Whole while it fits the plate, an ellipsis only when it is longer than the plate.
			label.textContent = fitLabel(s.name, (pw - 14) / fs);
			// badges
			const badge = el(
				"g",
				{ class: "badge" },
				el("g", { transform: `translate(${size * 0.42} ${-size * 0.9})` }, g),
			);
			const isDone = st === "done";
			const isErr = st === "error";
			el(
				"circle",
				{
					r: size * 0.17,
					fill: isDone ? STATE_COLOR.done : isErr ? STATE_COLOR.error : s.color,
				},
				badge,
			);
			const glyph = el(
				"text",
				{
					x: 0,
					y: size * 0.07,
					"text-anchor": "middle",
					"font-size": size * 0.22,
					"font-weight": 800,
					fill: "#fff",
				},
				badge,
			);
			glyph.textContent = isDone ? "✓" : isErr ? "✕" : "!";
			// thinking mote
			const orbit = el("g", { class: "orbit" }, g);
			el(
				"circle",
				{ cx: size * 0.38, cy: -size * 0.62, r: size * 0.055, fill: s.color },
				orbit,
			);
			el(
				"circle",
				{
					cx: -size * 0.38,
					cy: -size * 0.62,
					r: size * 0.035,
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
		resetCamera() {},
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
