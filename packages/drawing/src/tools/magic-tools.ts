import { Type } from "typebox";
import {
	CIRCLE_TYPES,
	MAX_CIRCLE_TEXT,
	renderMagicCircle,
} from "../magic-circle.ts";
import { MAX_LAYERS, renderSacredGeometry } from "../sacred-geometry.ts";
import { renderSigil } from "../sigil.ts";
import type { ToolWording } from "../tool-text.ts";
import {
	background,
	type ImageToolEnv,
	imageTool,
	literals,
	strictObject,
} from "./image-tool.ts";

const SIZES = { small: 512, medium: 1024, large: 2048 } as const;

export function magicCircleTool(env: ImageToolEnv, text: ToolWording) {
	return imageTool(
		{
			name: "magic_circle_generate",
			description: text.description,
			parameters: strictObject({
				type: literals(CIRCLE_TYPES, text.about("type")),
				style: Type.Optional(
					literals(["traditional", "modern", "geometric"], text.about("style")),
				),
				elements: Type.Optional(
					Type.Array(literals(["fire", "air", "water", "earth"]), {
						maxItems: 4,
						...text.about("elements"),
					}),
				),
				text: Type.Optional(
					Type.String({
						maxLength: MAX_CIRCLE_TEXT,
						...text.about("text"),
					}),
				),
				size: Type.Optional(
					literals(["small", "medium", "large"], text.about("size")),
				),
				background: background(text.about("background")),
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

export function sigilTool(
	env: ImageToolEnv,
	text: ToolWording,
	permissive = false,
) {
	return imageTool(
		{
			name: "sigil_generate",
			description: text.description,
			parameters: strictObject({
				intention: Type.String({
					minLength: 1,
					maxLength: 200,
					...text.about("intention"),
				}),
				method: literals(
					["chaos", "rose_cross", "planetary", "geometric"],
					text.about("method"),
				),
				complexity: Type.Optional(
					literals(["simple", "elaborate"], text.about("complexity")),
				),
				style: Type.Optional(
					literals(["traditional", "modern"], text.about("style")),
				),
				background: background(text.about("background")),
			}),
			draw: (args) => ({
				stem: "sigil",
				image: renderSigil({
					intention: args.intention,
					method: args.method,
					complexity: args.complexity ?? "elaborate",
					style: args.style ?? "traditional",
					background: args.background ?? "dark",
					permissive,
				}),
				text: "The sigil is attached to your reply as {file}.",
			}),
		},
		env,
	);
}

export function sacredGeometryTool(
	env: ImageToolEnv,
	text: ToolWording,
	permissive = false,
) {
	return imageTool(
		{
			name: "sacred_geometry_generate",
			description: text.description,
			parameters: strictObject({
				pattern: literals(
					["flower_of_life", "metatron", "sri_yantra", "vesica_pisces"],
					text.about("pattern"),
				),
				layers: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: MAX_LAYERS,
						...text.about("layers"),
					}),
				),
				rotation: Type.Optional(Type.Number(text.about("rotation"))),
				colors: Type.Optional(
					Type.Array(Type.String(), {
						maxItems: MAX_LAYERS,
						...text.about("colors"),
					}),
				),
				background: background(text.about("background")),
			}),
			draw: (args) => ({
				stem: "sacred-geometry",
				image: renderSacredGeometry({
					pattern: args.pattern,
					layers: args.layers ?? 3,
					rotation: args.rotation ?? 0,
					colors: args.colors ?? [],
					background: args.background ?? "dark",
					permissive,
				}),
				text: "The sacred geometry is attached to your reply as {file}.",
			}),
		},
		env,
	);
}
