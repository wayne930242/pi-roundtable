import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { AgentError } from "../domain/errors.ts";
import { toolError, toolText } from "../shared/tool-result.ts";

export type ToolInput = Record<string, unknown>;

/** A tool whose result is text for the model. */
export interface TextToolDef<Name extends string = string> {
	name: Name;
	label: string;
	description: string;
	parameters: TSchema;
	run(input: ToolInput, signal?: AbortSignal): Promise<string> | string;
}

type ErrorClass = abstract new (...args: never[]) => Error;

/**
 * Registers text tools. A thrown `refusal` becomes an error result the model reads; any other
 * error fails the call.
 */
export function textToolsExtension(
	defs: readonly TextToolDef[],
	refusal: ErrorClass,
): ExtensionFactory {
	return (pi) => {
		for (const def of defs) {
			pi.registerTool({
				name: def.name,
				label: def.label,
				description: def.description,
				parameters: def.parameters,
				execute: async (_toolCallId, params, signal) => {
					try {
						return toolText(await def.run(params as ToolInput, signal));
					} catch (error) {
						if (!(error instanceof refusal)) throw error;
						return toolError(error.message);
					}
				},
			});
		}
	};
}

/** A string argument, or undefined when absent. */
export function optionalString(input: ToolInput, key: string) {
	const value = input[key];
	return typeof value === "string" ? value : undefined;
}

/** A string argument that is not blank; throws AgentError otherwise. */
export function requiredString(input: ToolInput, key: string): string {
	const value = optionalString(input, key);
	if (!value?.trim()) throw new AgentError(`${key} is required.`);
	return value;
}

/** The strings of an array argument, or undefined when it is not an array. */
export function stringList(input: ToolInput, key: string) {
	const value = input[key];
	return Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: undefined;
}
