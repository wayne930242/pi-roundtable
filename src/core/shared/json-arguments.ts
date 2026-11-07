import type { TSchema } from "typebox";
import Value from "typebox/value";

/** Parses a value a model double-encoded as a JSON string; anything else, or a bad string, comes back as it was. */
// pi-lens-ignore: no-unknown-returns — this reads untyped model JSON; the tool schema is where it is parsed
export function decodedJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

/**
 * A tool call's arguments with each top-level string the schema refuses, but whose JSON decodes
 * to an array or object it accepts, replaced by that value. A model sometimes sends a list as the
 * text `["a"]`, most often where the schema offers a list or a word; pi would otherwise wrap that
 * text whole in a list of one. Anything else is left for the schema to judge.
 */
// pi-lens-ignore: no-unknown-returns — pi checks the prepared arguments against the tool schema right after
export function decodeJsonArguments(schema: TSchema, args: unknown): unknown {
	const properties = (schema as { properties?: Record<string, TSchema> })
		.properties;
	if (
		!properties ||
		typeof args !== "object" ||
		args === null ||
		Array.isArray(args)
	)
		return args;
	const input = args as Record<string, unknown>;
	let output: Record<string, unknown> | undefined;
	for (const [key, property] of Object.entries(properties)) {
		const value = input[key];
		if (typeof value !== "string" || !/^\s*[[{]/.test(value)) continue;
		if (Value.Check(property, value)) continue;
		const decoded = decodedJson(value);
		if (typeof decoded !== "object" || decoded === null) continue;
		const converted = Value.Convert(property, decoded);
		if (!Value.Check(property, converted)) continue;
		output ??= { ...input };
		output[key] = converted;
	}
	return output ?? args;
}
