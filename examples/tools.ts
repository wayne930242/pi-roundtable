import { definePlugin, defineTool, ToolRefusal } from "pi-roundtable";
import { Type } from "typebox";

/** Tools are what agents can call; each names the lowest tier of speaker whose turns may call it. */
export const notes = definePlugin({
	name: "notes",
	setup: () => {
		const saved: string[] = [];
		return {
			tools: [
				defineTool({
					name: "note_add",
					description:
						"Save a short note. Call it when asked to remember something.",
					parameters: Type.Object({ text: Type.String() }),
					minTier: "member",
					run: ({ text }, turn) => {
						// A refusal is read by the model, which can correct the call.
						if (text.trim() === "")
							throw new ToolRefusal("The note is empty. Ask what to save.");
						saved.push(text);
						return `Saved note ${saved.length} for ${turn.speaker?.name ?? "nobody"}.`;
					},
				}),
			],
		};
	},
});
