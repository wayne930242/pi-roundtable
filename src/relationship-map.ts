/**
 * Hand-drawn relationship maps: Rough.js on node-canvas, laid out with d3-force. Characters
 * (player and non-player) and factions are the nodes; typed relationships are the edges.
 */
import { type CanvasRenderingContext2D, createCanvas } from "canvas";
import {
	forceCenter,
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from "d3-force";
import rough from "roughjs";
import { DrawingError } from "./errors.ts";
import { type Random, roughSeed } from "./random.ts";
import { ensureFont, font } from "./style.ts";

export const NODE_TYPES = ["pc", "npc", "faction"] as const;
export const EDGE_TYPES = [
	"romantic",
	"entanglement",
	"bond",
	"faction",
	"hostile",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export type EdgeType = (typeof EDGE_TYPES)[number];

export const MAX_NODES = 40;
export const MAX_EDGES = 80;
/** Longest title, node id, node label, and edge label, in characters. */
export const MAX_TITLE = 80;
export const MAX_TEXT = 60;

export interface MapNode {
	id: string;
	type: NodeType;
	label?: string | undefined;
}

export interface MapEdge {
	from: string;
	to: string;
	type: EdgeType;
	label?: string | undefined;
}

export interface MapInput {
	nodes: readonly MapNode[];
	edges: readonly MapEdge[];
	title?: string | undefined;
}

const COLORS = {
	pc: { fill: "#FFE4E1", stroke: "#8B4513" },
	npc: { fill: "#E6F3FF", stroke: "#4682B4" },
	faction: { fill: "#F0FFF0", stroke: "#2E8B57" },
} as const;

const EDGE_STYLES: Record<
	EdgeType,
	{
		stroke: string;
		strokeWidth: number;
		roughness: number;
		dashGap?: number;
		arrow: "target" | "both" | "none";
	}
> = {
	romantic: {
		stroke: "#DC143C",
		strokeWidth: 2.5,
		roughness: 1.5,
		arrow: "target",
	},
	entanglement: {
		stroke: "#FF8C00",
		strokeWidth: 2,
		roughness: 1.2,
		dashGap: 8,
		arrow: "target",
	},
	bond: { stroke: "#808080", strokeWidth: 1.5, roughness: 1, arrow: "none" },
	faction: {
		stroke: "#2E8B57",
		strokeWidth: 1.5,
		roughness: 1,
		dashGap: 6,
		arrow: "target",
	},
	hostile: {
		stroke: "#1C1C1C",
		strokeWidth: 2.5,
		roughness: 2.5,
		arrow: "both",
	},
};

const CANVAS_PADDING = 80;
const NODE_RADIUS = { pc: 40, npc: 30 } as const;
const FACTION_SIZE = { w: 80, h: 36 } as const;
/** Room between a node's text and the edge of its shape. */
const TEXT_PAD = 10;
const LABEL_PAD = 3;
/** The picture stays within what canvas can allocate. */
const MAX_SIDE = 16384;
const LAYOUT_SIZE = 1200;

interface SimNode extends SimulationNodeDatum {
	id: string;
	x: number;
	y: number;
	type: NodeType;
	label?: string;
	/** Half the width and height of the shape, grown to hold the node's text. */
	halfW: number;
	halfH: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
	type: EdgeType;
	label?: string;
}

type RoughCanvas = ReturnType<typeof rough.canvas>;

function validate(input: MapInput): void {
	if (input.nodes.length === 0)
		throw new DrawingError("nodes cannot be empty. Give at least one node.");
	if (input.nodes.length > MAX_NODES)
		throw new DrawingError(
			`${input.nodes.length} nodes is over the limit of ${MAX_NODES}. Draw a smaller map.`,
		);
	if (input.edges.length > MAX_EDGES)
		throw new DrawingError(
			`${input.edges.length} edges is over the limit of ${MAX_EDGES}. Draw a smaller map.`,
		);
	const ids = new Set<string>();
	for (const node of input.nodes) {
		if (node.id.trim() === "")
			throw new DrawingError("A node has an empty id. Give every node a name.");
		if (ids.has(node.id))
			throw new DrawingError(
				`Two nodes share the id ${JSON.stringify(node.id)}. Node ids must be unique.`,
			);
		ids.add(node.id);
	}
	for (const edge of input.edges) {
		for (const end of [edge.from, edge.to])
			if (!ids.has(end))
				throw new DrawingError(
					`An edge references the unknown node ${JSON.stringify(end)}. Add it to nodes or fix the edge.`,
				);
		if (edge.from === edge.to)
			throw new DrawingError(
				`An edge from ${JSON.stringify(edge.from)} to itself cannot be drawn. Connect two different nodes.`,
			);
	}
}

/** The text of a node, as it is drawn: the id, then the label under it. */
function nodeFonts(type: NodeType) {
	return {
		id: font(type === "pc" ? 16 : 14),
		label: font(type === "pc" ? 12 : 11),
	};
}

function shapeOf(
	measure: CanvasRenderingContext2D,
	n: MapNode,
): { halfW: number; halfH: number } {
	const fonts = nodeFonts(n.type);
	measure.font = fonts.id;
	let width = measure.measureText(n.id).width;
	if (n.label) {
		measure.font = fonts.label;
		width = Math.max(width, measure.measureText(n.label).width);
	}
	if (n.type === "faction")
		return {
			halfW: Math.max(FACTION_SIZE.w, width + TEXT_PAD * 2) / 2,
			halfH: FACTION_SIZE.h / 2,
		};
	const radius = NODE_RADIUS[n.type];
	return { halfW: Math.max(radius, width / 2 + TEXT_PAD), halfH: radius };
}

function computeLayout(
	input: MapInput,
	random: Random,
	measure: CanvasRenderingContext2D,
): { nodes: SimNode[]; links: SimLink[] } {
	const nodes: SimNode[] = input.nodes.map((n) => ({
		id: n.id,
		x: LAYOUT_SIZE / 2 + (random() - 0.5) * 200,
		y: LAYOUT_SIZE / 2 + (random() - 0.5) * 200,
		type: n.type,
		...shapeOf(measure, n),
		...(n.label ? { label: n.label } : {}),
	}));
	const links: SimLink[] = input.edges.map((e) => ({
		source: e.from,
		target: e.to,
		type: e.type,
		...(e.label ? { label: e.label } : {}),
	}));
	const simulation = forceSimulation<SimNode>(nodes)
		.randomSource(random)
		.force(
			"link",
			forceLink<SimNode, SimLink>(links)
				.id((d) => d.id)
				.distance((link) => {
					const [a, b] = [link.source, link.target].map((end) =>
						typeof end === "object" ? (end as SimNode).halfW : 0,
					);
					return Math.max(160, (a ?? 0) + (b ?? 0) + 40);
				}),
		)
		.force("charge", forceManyBody().strength(-400))
		.force("center", forceCenter(LAYOUT_SIZE / 2, LAYOUT_SIZE / 2))
		.force(
			"collide",
			forceCollide<SimNode>((n) => Math.max(60, n.halfW + 10)),
		)
		.stop();
	for (let i = 0; i < 300; i++) simulation.tick();
	return { nodes, links };
}

/** How far the edge of a node's shape is from its centre along the unit direction (ux, uy). */
function reach(node: SimNode, ux: number, uy: number): number {
	if (node.type === "faction")
		return Math.min(
			ux === 0 ? Infinity : node.halfW / Math.abs(ux),
			uy === 0 ? Infinity : node.halfH / Math.abs(uy),
		);
	// The shape is an ellipse.
	return (
		(node.halfW * node.halfH) / Math.hypot(node.halfH * ux, node.halfW * uy)
	);
}

function drawArrowHead(
	ctx: CanvasRenderingContext2D,
	from: { x: number; y: number },
	tip: { x: number; y: number },
	color: string,
): void {
	const size = 12;
	const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
	ctx.save();
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.moveTo(tip.x, tip.y);
	ctx.lineTo(
		tip.x - size * Math.cos(angle - Math.PI / 6),
		tip.y - size * Math.sin(angle - Math.PI / 6),
	);
	ctx.lineTo(
		tip.x - size * Math.cos(angle + Math.PI / 6),
		tip.y - size * Math.sin(angle + Math.PI / 6),
	);
	ctx.closePath();
	ctx.fill();
	ctx.restore();
}

function endOf(ref: SimLink["source"], byId: ReadonlyMap<string, SimNode>) {
	const id = typeof ref === "object" ? ref.id : String(ref);
	return byId.get(id);
}

function drawEdge(
	rc: RoughCanvas,
	ctx: CanvasRenderingContext2D,
	link: SimLink,
	byId: ReadonlyMap<string, SimNode>,
	random: Random,
): void {
	const src = endOf(link.source, byId);
	const tgt = endOf(link.target, byId);
	if (!src || !tgt) return;
	const style = EDGE_STYLES[link.type];
	const dx = tgt.x - src.x;
	const dy = tgt.y - src.y;
	const dist = Math.hypot(dx, dy);
	// The line runs between the edges of the two shapes, not through them.
	let [from, to] = [
		{ x: src.x, y: src.y },
		{ x: tgt.x, y: tgt.y },
	];
	if (dist > 0) {
		const ux = dx / dist;
		const uy = dy / dist;
		const [out, into] = [reach(src, ux, uy) + 4, reach(tgt, -ux, -uy) + 4];
		if (dist > out + into + 8) {
			from = { x: src.x + ux * out, y: src.y + uy * out };
			to = { x: tgt.x - ux * into, y: tgt.y - uy * into };
		}
		if (style.arrow === "target" || style.arrow === "both")
			drawArrowHead(ctx, from, to, style.stroke);
		if (style.arrow === "both") drawArrowHead(ctx, to, from, style.stroke);
	}
	rc.line(from.x, from.y, to.x, to.y, {
		stroke: style.stroke,
		strokeWidth: style.strokeWidth,
		roughness: style.roughness,
		seed: roughSeed(random),
		...(style.dashGap
			? { strokeLineDash: [style.dashGap, style.dashGap] }
			: {}),
	});

	if (link.label) {
		const mx = (src.x + tgt.x) / 2;
		const my = (src.y + tgt.y) / 2;
		ctx.save();
		ctx.font = font(11);
		const width = ctx.measureText(link.label).width;
		const pad = LABEL_PAD;
		ctx.fillStyle = "rgba(255,255,255,0.85)";
		ctx.fillRect(
			mx - width / 2 - pad,
			my - 8 - pad,
			width + pad * 2,
			16 + pad * 2,
		);
		ctx.fillStyle = style.stroke;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(link.label, mx, my);
		ctx.restore();
	}
}

function drawNode(
	rc: RoughCanvas,
	ctx: CanvasRenderingContext2D,
	node: SimNode,
	random: Random,
): void {
	const colors = COLORS[node.type];
	const seed = roughSeed(random);
	const fill = {
		fill: colors.fill,
		fillStyle: "hachure",
		fillWeight: 0.5,
		stroke: colors.stroke,
		seed,
	};
	if (node.type === "faction") {
		rc.rectangle(
			node.x - node.halfW,
			node.y - node.halfH,
			node.halfW * 2,
			node.halfH * 2,
			{ ...fill, strokeWidth: 1.5, roughness: 1.2, hachureGap: 6 },
		);
	} else {
		rc.ellipse(node.x, node.y, node.halfW * 2, node.halfH * 2, {
			...fill,
			strokeWidth: 2,
			roughness: 1.5,
			hachureGap: 5,
		});
	}

	ctx.save();
	ctx.font = font(node.type === "pc" ? 16 : 14);
	ctx.fillStyle = "#333";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(node.id, node.x, node.y - (node.label ? 8 : 0));
	if (node.label) {
		ctx.font = font(node.type === "pc" ? 12 : 11);
		ctx.fillStyle = "#666";
		ctx.fillText(node.label, node.x, node.y + 12);
	}
	ctx.restore();
}

/**
 * Draws the map as a PNG sized to its content. The layout and the hand-drawn wobble both come
 * from `random`, so a seeded source draws the same map every time.
 */
export function renderRelationshipMap(
	input: MapInput,
	random: Random = Math.random,
): Uint8Array {
	validate(input);
	ensureFont();
	// The shapes grow to hold their text, so the text is measured before the layout.
	const measure = createCanvas(1, 1).getContext("2d");
	const { nodes, links } = computeLayout(input, random, measure);

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const include = (x0: number, y0: number, x1: number, y1: number) => {
		minX = Math.min(minX, x0);
		minY = Math.min(minY, y0);
		maxX = Math.max(maxX, x1);
		maxY = Math.max(maxY, y1);
	};
	for (const n of nodes)
		include(n.x - n.halfW, n.y - n.halfH, n.x + n.halfW, n.y + n.halfH);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	measure.font = font(11);
	for (const link of links) {
		const src = endOf(link.source, byId);
		const tgt = endOf(link.target, byId);
		if (!link.label || !src || !tgt) continue;
		const half = measure.measureText(link.label).width / 2 + LABEL_PAD;
		const [mx, my] = [(src.x + tgt.x) / 2, (src.y + tgt.y) / 2];
		include(mx - half, my - 8 - LABEL_PAD, mx + half, my + 8 + LABEL_PAD);
	}
	let titleWidth = 0;
	if (input.title) {
		measure.font = font(20);
		titleWidth = measure.measureText(input.title).width;
	}
	const titleOffset = input.title ? 40 : 0;
	const width = Math.ceil(
		Math.max(400, maxX - minX + CANVAS_PADDING * 2, titleWidth + 40),
	);
	const height = Math.ceil(
		Math.max(300, maxY - minY + CANVAS_PADDING * 2 + titleOffset),
	);
	if (width > MAX_SIDE || height > MAX_SIDE)
		throw new DrawingError(
			`The map would be ${width} by ${height} px, which is too large to draw. Use shorter names or fewer nodes.`,
		);
	// The graph is centred; the title sits above it.
	const offsetX = (width - (maxX - minX)) / 2 - minX;
	const offsetY = CANVAS_PADDING + titleOffset - minY;
	for (const n of nodes) {
		n.x += offsetX;
		n.y += offsetY;
	}

	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#FFFEF5";
	ctx.fillRect(0, 0, width, height);
	if (input.title) {
		ctx.save();
		ctx.font = font(20);
		ctx.fillStyle = "#333";
		ctx.textAlign = "center";
		ctx.fillText(input.title, width / 2, 35);
		ctx.restore();
	}

	// SAFETY: Rough.js draws through the 2D context, which node-canvas provides in the browser's shape.
	const rc = rough.canvas(
		canvas as unknown as Parameters<typeof rough.canvas>[0],
	);
	for (const link of links) drawEdge(rc, ctx, link, byId, random);
	for (const node of nodes) drawNode(rc, ctx, node, random);
	return new Uint8Array(canvas.toBuffer("image/png"));
}
