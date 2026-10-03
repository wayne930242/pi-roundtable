import {
	validFunctionName as functionName,
	validCallId as identifier,
	isRecord,
} from "./protocol.ts";

interface ModelInput {
	messages: Record<string, unknown>[];
	tools?: Record<string, unknown>[];
}

export function localSchema(value: unknown): boolean {
	if (typeof value === "boolean") return true;
	if (!isRecord(value)) return false;
	for (const key of [
		"$ref",
		"$dynamicRef",
		"$recursiveRef",
		"$schema",
		"$id",
	]) {
		if (
			value[key] !== undefined &&
			(typeof value[key] !== "string" || !value[key].startsWith("#"))
		)
			return false;
	}
	if (
		value.$vocabulary !== undefined &&
		(!isRecord(value.$vocabulary) ||
			Object.keys(value.$vocabulary).some((uri) => !uri.startsWith("#")))
	)
		return false;
	// Recurse only into schema positions; property names and enum/const data are not keywords.
	for (const key of [
		"properties",
		"patternProperties",
		"$defs",
		"definitions",
		"dependentSchemas",
	]) {
		if (
			value[key] !== undefined &&
			(!isRecord(value[key]) || !Object.values(value[key]).every(localSchema))
		)
			return false;
	}
	for (const key of [
		"items",
		"contains",
		"additionalProperties",
		"unevaluatedProperties",
		"unevaluatedItems",
		"propertyNames",
		"not",
		"if",
		"then",
		"else",
		"contentSchema",
		"additionalItems",
	]) {
		if (
			value[key] !== undefined &&
			!(Array.isArray(value[key])
				? value[key].every(localSchema)
				: localSchema(value[key]))
		)
			return false;
	}
	for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
		if (
			value[key] !== undefined &&
			(!Array.isArray(value[key]) || !value[key].every(localSchema))
		)
			return false;
	}
	if (
		isRecord(value.dependencies) &&
		Object.values(value.dependencies).some(
			(entry) => !Array.isArray(entry) && !localSchema(entry),
		)
	)
		return false;
	return true;
}

/** Model traffic is text plus function calls only: no account files, media URLs or native provider tools. */
export function modelInput(
	body: Record<string, unknown>,
): ModelInput | undefined {
	if (!Array.isArray(body.messages) || body.messages.length > 128)
		return undefined;
	const messages: Record<string, unknown>[] = [];
	for (const raw of body.messages) {
		if (
			!isRecord(raw) ||
			typeof raw.role !== "string" ||
			!["system", "user", "assistant", "tool"].includes(raw.role) ||
			typeof raw.content !== "string"
		)
			return undefined;
		if (
			Object.keys(raw).some(
				(key) =>
					!["role", "content", "tool_calls", "tool_call_id"].includes(key),
			)
		)
			return undefined;
		const message: Record<string, unknown> = {
			role: raw.role,
			content: raw.content,
		};
		if (raw.tool_calls !== undefined) {
			if (
				raw.role !== "assistant" ||
				!Array.isArray(raw.tool_calls) ||
				raw.tool_calls.length > 8
			)
				return undefined;
			const calls: Record<string, unknown>[] = [];
			for (const call of raw.tool_calls) {
				if (
					!isRecord(call) ||
					call.type !== "function" ||
					!identifier(call.id) ||
					!isRecord(call.function) ||
					!functionName(call.function.name) ||
					typeof call.function.arguments !== "string"
				)
					return undefined;
				calls.push({
					id: call.id,
					type: "function",
					function: {
						name: call.function.name,
						arguments: call.function.arguments,
					},
				});
			}
			message.tool_calls = calls;
		}
		if (raw.role === "tool") {
			if (!identifier(raw.tool_call_id)) return undefined;
			message.tool_call_id = raw.tool_call_id;
		} else if (raw.tool_call_id !== undefined) return undefined;
		messages.push(message);
	}
	let tools: Record<string, unknown>[] | undefined;
	if (body.tools !== undefined) {
		if (!Array.isArray(body.tools) || body.tools.length > 128) return undefined;
		tools = [];
		const names = new Set<string>();
		for (const tool of body.tools) {
			if (
				!isRecord(tool) ||
				tool.type !== "function" ||
				!isRecord(tool.function) ||
				!functionName(tool.function.name) ||
				names.has(tool.function.name) ||
				typeof tool.function.description !== "string" ||
				!isRecord(tool.function.parameters) ||
				!localSchema(tool.function.parameters)
			)
				return undefined;
			names.add(tool.function.name);
			tools.push({
				type: "function",
				function: {
					name: tool.function.name,
					description: tool.function.description,
					parameters: tool.function.parameters,
				},
			});
		}
	}
	return { messages, ...(tools ? { tools } : {}) };
}
