import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	defineTool,
	REPLY_FILE_LIMITS,
	type Tier,
	type ToolContribution,
	ToolRefusal,
	type ToolTurn,
} from "pi-roundtable";
import { type Static, type TObject, type TProperties, Type } from "typebox";
import Value from "typebox/value";
import { DrawingError } from "../errors.ts";

/** A string that is one of `values`, which the model reads as an enum. */
export const literals = <T extends string>(
	values: readonly T[],
	description?: string,
) =>
	Type.Union(
		values.map((value) => Type.Literal(value)),
		description ? { description } : {},
	);

/** An argument object that refuses a name it does not know, so a misspelled argument is a refusal rather than a default. */
export const strictObject = <Properties extends TProperties>(
	properties: Properties,
) => Type.Object(properties, { additionalProperties: false });

export const BACKGROUNDS = ["dark", "white", "transparent"] as const;

export const BACKGROUND = Type.Optional(literals(BACKGROUNDS, "Default dark."));

/** What a drawing tool produced: the picture, the name it is attached under, and what the model reads back. */
export interface Drawn {
	/** The file name without its extension; the tool adds `.png`. */
	stem: string;
	image: Uint8Array;
	text: string;
}

export interface ImageToolSpec<Schema extends TObject> {
	name: string;
	description: string;
	parameters: Schema;
	draw(args: Static<Schema>, turn: ToolTurn): Promise<Drawn> | Drawn;
}

export interface ImageToolEnv {
	minTier: Tier;
}

/** The pi session checks a call against its schema; this check also covers a tool run without a session. */
function checkArguments<Schema extends TObject>(
	schema: Schema,
	args: unknown,
): asserts args is Static<Schema> {
	if (Value.Check(schema, args)) return;
	const problems = Value.Errors(schema, args)
		.slice(0, 3)
		.map((error) => `${error.instancePath || "arguments"}: ${error.message}`);
	throw new ToolRefusal(
		`The arguments are not valid (${problems.join("; ")}). Fix them and call again.`,
	);
}

/**
 * Saves a picture under the session's scratch dir, or its workspace without one, so the model can
 * send it on by path; says where, or why not. A session with neither saves nothing.
 */
async function saveDrawing(
	tool: string,
	image: Uint8Array,
	turn: ToolTurn,
): Promise<string | undefined> {
	const root = turn.workspace?.scratchDir ?? turn.workspace?.workspace;
	if (root === undefined) return undefined;
	const dir = join(root, "drawings");
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const path = join(dir, `${tool}-${stamp}.png`);
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(path, image, { flag: "wx" });
	} catch (error) {
		return `It was not saved to a file (${error instanceof Error ? error.message : String(error)}).`;
	}
	return `It is also saved at ${path}; to send it elsewhere, give this path to discord_send_message or attach_file rather than reading it.`;
}

/**
 * A tool that draws one image, attaches it to the agent's reply as a file, and saves it in the
 * session's scratch dir or workspace when it has one. A request the renderer
 * cannot honour comes back to the model as a refusal it can correct.
 */
export function imageTool<Schema extends TObject>(
	spec: ImageToolSpec<Schema>,
	env: ImageToolEnv,
): ToolContribution {
	return defineTool({
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		minTier: env.minTier,
		run: async (args, turn) => {
			checkArguments(spec.parameters, args);
			let drawn: Drawn;
			try {
				drawn = await spec.draw(args, turn);
			} catch (error) {
				if (error instanceof DrawingError) throw new ToolRefusal(error.message);
				throw error;
			}
			const name = `${drawn.stem}.png`;
			// The host refuses a larger file too, but only with its own wording, and a model can act on this one.
			if (drawn.image.byteLength > REPLY_FILE_LIMITS.maxFileBytes)
				throw new ToolRefusal(
					`The picture is ${(drawn.image.byteLength / 2 ** 20).toFixed(1)} MiB, over the ${REPLY_FILE_LIMITS.maxFileBytes / 2 ** 20} MiB a reply may carry. Ask for a smaller picture, such as fewer cards or a smaller size.`,
				);
			turn.attachFile({ name, data: drawn.image });
			const text = drawn.text.replace("{file}", name);
			const saved = await saveDrawing(spec.name, drawn.image, turn);
			return saved ? `${text}\n\n${saved}` : text;
		},
	});
}
