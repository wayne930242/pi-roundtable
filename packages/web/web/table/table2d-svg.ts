import type { Hall } from "./hall";

const NS = "http://www.w3.org/2000/svg";

export const el = <K extends keyof SVGElementTagNameMap>(
	tag: K,
	attrs: Record<string, string | number> = {},
	parent?: Element,
) => {
	const e = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
	parent?.appendChild(e);
	return e;
};

export const dataUri = (svg: string) => {
	const sized = /<svg[^>]*\swidth=/.test(svg)
		? svg
		: svg.replace("<svg", '<svg width="256" height="256"');
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
};

/** The filter that cuts a figure out as a standee: a light rim and a dark line round it. */
export function rimFilter(
	uid: string,
	defs: Element,
	hall: Hall,
	size: number,
) {
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
