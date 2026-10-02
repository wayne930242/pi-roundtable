import {
	type ChannelKey,
	defineTool,
	type Tier,
	type ToolContribution,
	ToolRefusal,
	type ToolTurn,
} from "pi-roundtable";
import { type Static, type TObject, type TProperties, Type } from "typebox";
import Value from "typebox/value";
import { DrawingError } from "../errors.ts";

/** Posts a drawn image to the channel of the turn that asked for it. */
export type SendImage = (
	channel: ChannelKey,
	file: { name: string; data: Uint8Array },
) => Promise<void>;

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

/** What a drawing tool produced: the picture, the name it is posted under, and what the model reads back. */
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
	send: SendImage;
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
 * A tool that draws one image and posts it to the channel as a file. A request the renderer
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
			await env.send(turn.channel, { name, data: drawn.image });
			return drawn.text.replace("{file}", name);
		},
	});
}
