import { Type } from "typebox";
import type { Random } from "../random.ts";
import {
	EDGE_TYPES,
	MAX_EDGES,
	MAX_NODES,
	NODE_TYPES,
	renderRelationshipMap,
} from "../relationship-map.ts";
import { type ImageToolEnv, imageTool, literals } from "./image-tool.ts";

export function relationshipMapTool(env: ImageToolEnv, random: Random) {
	return imageTool(
		{
			name: "relationship_map",
			description:
				"Draw a hand-drawn relationship map of characters (pc, npc) and factions, with typed relationships between them, and post it to the channel as an image.",
			parameters: Type.Object({
				title: Type.Optional(Type.String()),
				nodes: Type.Array(
					Type.Object({
						id: Type.String({ description: "Character or faction name." }),
						type: literals(NODE_TYPES),
						label: Type.Optional(
							Type.String({ description: "A sub-label such as a role." }),
						),
					}),
					{ minItems: 1, maxItems: MAX_NODES },
				),
				edges: Type.Array(
					Type.Object({
						from: Type.String({ description: "The id of a node." }),
						to: Type.String({ description: "The id of another node." }),
						type: literals(
							EDGE_TYPES,
							"romantic: arrow; entanglement: dashed arrow; bond: plain line; faction: dashed arrow; hostile: arrows both ways.",
						),
						label: Type.Optional(Type.String()),
					}),
					{ maxItems: MAX_EDGES },
				),
			}),
			draw: (args) => ({
				stem: "relationship-map",
				image: renderRelationshipMap(args, random),
				text: "The relationship map is posted to the channel as {file}.",
			}),
		},
		env,
	);
}
