import { resolveCharacter } from "../../characters/index.ts";
import { characterPng } from "../../core/agents/character-png.ts";
import { fail, ok, type Result } from "../report.ts";

/** Rasterizes one composition, as the agent server does for every agent's picture. */
const rasterize = async (): Promise<unknown> =>
	characterPng(resolveCharacter({ class: "wizard" }), { size: 64 });

/** Whether `canvas` can rasterize the composer's SVG, which the agent server needs to draw its agents. */
export async function checkCharacters(
	probe: () => Promise<unknown> = rasterize,
): Promise<Result> {
	try {
		await probe();
		return ok("canvas rasterizes the agents' composed pictures");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return fail(
			`canvas cannot rasterize SVG, so the agent server cannot draw the agents' pictures: ${reason}`,
			"Install canvas with SVG support (librsvg), as the installation guide for your system describes, then run the check again.",
		);
	}
}
