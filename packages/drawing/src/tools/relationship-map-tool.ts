import { Type } from "typebox";
import type { RelationshipMapLimits } from "../plugin.ts";
import type { Random } from "../random.ts";
import {
	EDGE_TYPES,
	MAX_EDGES,
	MAX_NODES,
	MAX_TEXT,
	MAX_TITLE,
	NODE_TYPES,
	renderRelationshipMap,
} from "../relationship-map.ts";
import type { ToolWording } from "../tool-text.ts";
import {
	type ImageToolEnv,
	imageTool,
	literals,
	strictObject,
} from "./image-tool.ts";

export function relationshipMapTool(
	env: ImageToolEnv,
	text: ToolWording,
	random: Random,
	limits: RelationshipMapLimits = {},
	permissive = false,
) {
	const maxTitle = limits.title ?? MAX_TITLE;
	const maxText = limits.text ?? MAX_TEXT;
	return imageTool(
		{
			name: "relationship_map",
			description: text.description,
			parameters: strictObject({
				title: Type.Optional(
					Type.String({ maxLength: maxTitle, ...text.about("title") }),
				),
				nodes: Type.Array(
					strictObject({
						id: Type.String({
							minLength: permissive ? 0 : 1,
							maxLength: maxText,
							...text.about("nodes.id"),
						}),
						type: literals(NODE_TYPES, text.about("nodes.type")),
						label: Type.Optional(
							Type.String({
								maxLength: maxText,
								...text.about("nodes.label"),
							}),
						),
					}),
					{ minItems: 1, maxItems: MAX_NODES, ...text.about("nodes") },
				),
				edges: Type.Array(
					strictObject({
						from: Type.String(text.about("edges.from")),
						to: Type.String(text.about("edges.to")),
						type: literals(EDGE_TYPES, text.about("edges.type")),
						label: Type.Optional(
							Type.String({ maxLength: maxText, ...text.about("edges.label") }),
						),
					}),
					{ maxItems: MAX_EDGES, ...text.about("edges") },
				),
			}),
			draw: (args) => ({
				stem: "relationship-map",
				image: renderRelationshipMap(args, random, permissive),
				text: "The relationship map is attached to your reply as {file}.",
			}),
		},
		env,
	);
}
