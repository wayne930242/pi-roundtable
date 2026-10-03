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
import {
	type ImageToolEnv,
	imageTool,
	literals,
	strictObject,
} from "./image-tool.ts";

export function relationshipMapTool(
	env: ImageToolEnv,
	random: Random,
	limits: RelationshipMapLimits = {},
) {
	const maxTitle = limits.title ?? MAX_TITLE;
	const maxText = limits.text ?? MAX_TEXT;
	return imageTool(
		{
			name: "relationship_map",
			description:
				"Draw a hand-drawn relationship map of characters (pc, npc) and factions, with typed relationships between them, and attach it to your reply as an image.",
			parameters: strictObject({
				title: Type.Optional(Type.String({ maxLength: maxTitle })),
				nodes: Type.Array(
					strictObject({
						id: Type.String({
							minLength: 1,
							maxLength: maxText,
							description: "Character or faction name.",
						}),
						type: literals(NODE_TYPES),
						label: Type.Optional(
							Type.String({
								maxLength: maxText,
								description: "A sub-label such as a role.",
							}),
						),
					}),
					{ minItems: 1, maxItems: MAX_NODES },
				),
				edges: Type.Array(
					strictObject({
						from: Type.String({ description: "The id of a node." }),
						to: Type.String({ description: "The id of another node." }),
						type: literals(
							EDGE_TYPES,
							"romantic: arrow; entanglement: dashed arrow; bond: plain line; faction: dashed arrow; hostile: arrows both ways.",
						),
						label: Type.Optional(Type.String({ maxLength: maxText })),
					}),
					{ maxItems: MAX_EDGES },
				),
			}),
			draw: (args) => ({
				stem: "relationship-map",
				image: renderRelationshipMap(args, random),
				text: "The relationship map is attached to your reply as {file}.",
			}),
		},
		env,
	);
}
