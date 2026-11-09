import type { ReplyFile } from "pi-roundtable";
import { testPlugin } from "pi-roundtable/testing";
import { drawing } from "../plugin.ts";
import { RecordingSurface } from "./fake-surface.ts";

/** The plugin under test with a recording surface, which keeps what the tools post. */
export async function open(options: Parameters<typeof drawing>[0] = {}) {
	const surface = new RecordingSurface();
	const harness = await testPlugin(drawing(options), { surfaces: [surface] });
	return { harness, surface };
}

/** The files the tools attached to the reply, in order. */
export const filesOf = (harness: { files: { file: ReplyFile }[] }) =>
	harness.files.map(({ file }) => file);

export const MAP = {
	title: "The Harbour",
	nodes: [
		{ id: "Ada", type: "pc", label: "captain" },
		{ id: "Bram", type: "npc" },
		{ id: "Guild", type: "faction" },
	],
	edges: [
		{ from: "Ada", to: "Bram", type: "romantic", label: "loves" },
		{ from: "Bram", to: "Guild", type: "faction" },
		{ from: "Ada", to: "Guild", type: "hostile" },
	],
};
