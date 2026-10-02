import { Type } from "typebox";
import {
	CIRCLE_TYPES,
	MAX_CIRCLE_TEXT,
	MAX_LAYERS,
	renderMagicCircle,
	renderSacredGeometry,
	renderSigil,
} from "../magic.ts";
import {
	BACKGROUND,
	type ImageToolEnv,
	imageTool,
	literals,
	strictObject,
} from "./image-tool.ts";

const SIZES = { small: 512, medium: 1024, large: 2048 } as const;

export function magicCircleTool(env: ImageToolEnv) {
	return imageTool(
		{
			name: "magic_circle_generate",
			description:
				"Draw a magic circle: a pentagram, hexagram, or Tree of Life, with optional elemental symbols at the quarters and text around the rim, and attach it to your reply as an image.",
			parameters: strictObject({
				type: literals(CIRCLE_TYPES, "custom draws a pentagram."),
				style: Type.Optional(
					literals(["traditional", "modern", "geometric"], "Line weight."),
				),
				elements: Type.Optional(
					Type.Array(literals(["fire", "air", "water", "earth"]), {
						maxItems: 4,
						description: "Placed north, east, south, west in this order.",
					}),
				),
				text: Type.Optional(
					Type.String({
						maxLength: MAX_CIRCLE_TEXT,
						description: "Written around the rim.",
					}),
				),
				size: Type.Optional(
					literals(
						["small", "medium", "large"],
						"512, 1024, or 2048 px; default medium.",
					),
				),
				background: BACKGROUND,
			}),
			draw: (args) => ({
				stem: "magic-circle",
				image: renderMagicCircle({
					type: args.type,
					style: args.style ?? "traditional",
					size: SIZES[args.size ?? "medium"],
					background: args.background ?? "dark",
					...(args.elements ? { elements: args.elements } : {}),
					...(args.text ? { text: args.text } : {}),
				}),
				text: "The magic circle is attached to your reply as {file}.",
			}),
		},
		env,
	);
}

export function sigilTool(env: ImageToolEnv) {
	return imageTool(
		{
			name: "sigil_generate",
			description:
				"Draw a sigil from an intention, by the chaos (letter elimination), rose cross, planetary, or geometric method, and attach it to your reply as an image.",
			parameters: strictObject({
				intention: Type.String({ minLength: 1, maxLength: 200 }),
				method: literals(["chaos", "rose_cross", "planetary", "geometric"]),
				complexity: Type.Optional(literals(["simple", "elaborate"])),
				style: Type.Optional(literals(["traditional", "modern"])),
				background: BACKGROUND,
			}),
			draw: (args) => ({
				stem: "sigil",
				image: renderSigil({
					intention: args.intention,
					method: args.method,
					complexity: args.complexity ?? "elaborate",
					style: args.style ?? "traditional",
					background: args.background ?? "dark",
				}),
				text: "The sigil is attached to your reply as {file}.",
			}),
		},
		env,
	);
}

export function sacredGeometryTool(env: ImageToolEnv) {
	return imageTool(
		{
			name: "sacred_geometry_generate",
			description:
				"Draw sacred geometry: the Flower of Life, Metatron's Cube, a simplified Sri Yantra (nested triangles around a point, in a circle), or the Vesica Piscis, and attach it to your reply as an image. More layers add rings of circles, nested shapes, or, for Metatron's Cube, the outer ring (two or more layers).",
			parameters: strictObject({
				pattern: literals([
					"flower_of_life",
					"metatron",
					"sri_yantra",
					"vesica_pisces",
				]),
				layers: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: MAX_LAYERS,
						description: "Default 3.",
					}),
				),
				rotation: Type.Optional(Type.Number({ description: "Degrees." })),
				colors: Type.Optional(
					Type.Array(Type.String(), {
						maxItems: MAX_LAYERS,
						description: "CSS colors cycled per layer.",
					}),
				),
				background: BACKGROUND,
			}),
			draw: (args) => ({
				stem: "sacred-geometry",
				image: renderSacredGeometry({
					pattern: args.pattern,
					layers: args.layers ?? 3,
					rotation: args.rotation ?? 0,
					colors: args.colors ?? [],
					background: args.background ?? "dark",
				}),
				text: "The sacred geometry is attached to your reply as {file}.",
			}),
		},
		env,
	);
}
