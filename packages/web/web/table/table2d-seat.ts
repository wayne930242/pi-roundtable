import { type Hall, STATE_COLOR } from "./hall";
import { fitLabel } from "./label";
import { PLATE_FONT_STACK } from "./plate";
import { dataUri, el } from "./table2d-svg";
import { talkFrames } from "./talk";
import type { SeatInit, SeatState, TableLabels, TableOptions } from "./types";
import { pointOf } from "./types";

/** What a seat is drawn against: the hall, the pictures and states of the seats, and the size of a figure. */
export interface SeatScene {
	svg: SVGSVGElement;
	hall: Hall;
	uid: string;
	opts: TableOptions;
	labels: TableLabels;
	states: ReadonlyMap<string, SeatState>;
	svgs: ReadonlyMap<string, string>;
	talks: ReadonlyMap<string, string>;
	marks: ReadonlyMap<string, string>;
	reduced: boolean;
	focusId: string | null;
	pw: number;
	ph: number;
	figure: number;
	slotW: number;
}

/** One seat: its podium and standee at (`x`, `y`), the badge and the mote, and the click and key that open its menu. */
export function drawSeat(
	scene: SeatScene,
	s: SeatInit,
	i: number,
	x: number,
	y: number,
): void {
	const {
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
	} = scene;
	const st = states.get(s.id) ?? "idle";
	const g = el(
		"g",
		{
			class: "seat",
			"data-seat": s.id,
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
		const place = {
			x: -figure / 2,
			y: -ph - figure * 0.78,
			width: figure,
			height: figure * 0.88,
			filter: `url(#${uid}-rim)`,
		};
		el(
			"image",
			{
				href: dataUri(picture),
				...place,
				...(s.dim ? { opacity: 0.55 } : {}),
			},
			lift,
		);
		// A speaker's mouth: the open-mouthed picture over the closed one, shown and hidden at the talking beat.
		const talk = talks.get(s.id);
		if (st === "speaking" && talk && !reduced) {
			const open = el(
				"image",
				{ class: "talk", href: dataUri(talk), ...place, opacity: 0 },
				lift,
			);
			const { frames, seconds } = talkFrames(i);
			el(
				"animate",
				{
					attributeName: "opacity",
					values: frames.join(";"),
					dur: `${seconds.toFixed(3)}s`,
					calcMode: "discrete",
					repeatCount: "indefinite",
				},
				open,
			);
		}
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
	const mark = marks.get(s.id);
	label.textContent = fitLabel(
		mark ? `${mark} ${s.name}` : s.name,
		(plateW - 8) / fs,
	);
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
	g.addEventListener("click", (e) =>
		opts.onSeatClick({
			id: s.id,
			name: s.name,
			at: pointOf(e as MouseEvent, g),
		}),
	);
	g.addEventListener("keydown", (e) => {
		if (
			(e as KeyboardEvent).key === "Enter" ||
			(e as KeyboardEvent).key === " "
		) {
			e.preventDefault();
			opts.onSeatClick({
				id: s.id,
				name: s.name,
				at: pointOf({ clientX: 0, clientY: 0, detail: 0 }, g),
			});
		}
	});
}
