import { localSchema } from "./model-input.ts";
import { type PiThinkingLevel, validateImages } from "./pi-protocol.ts";
import { isRecord, validCallId } from "./protocol.ts";

function validFunctionName(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function cache(value: Record<string, unknown>): Record<string, unknown> {
	return isRecord(value.cache_control) &&
		value.cache_control.type === "ephemeral"
		? {
				cache_control: {
					type: "ephemeral",
					...(value.cache_control.ttl === "1h" ? { ttl: "1h" } : {}),
				},
			}
		: {};
}
function blocks(raw: unknown, nested = false): unknown[] | string {
	if (typeof raw === "string") return raw;
	if (!Array.isArray(raw) || raw.length > 256)
		throw new Error("Invalid content");
	return raw.map((value: unknown) => {
		if (!isRecord(value)) throw new Error("Invalid block");
		switch (value.type) {
			case "text":
				if (typeof value.text !== "string") break;
				return { type: "text", text: value.text, ...cache(value) };
			case "image": {
				const source = value.source;
				if (!isRecord(source) || source.type !== "base64") break;
				validateImages([{ data: source.data, mimeType: source.media_type }]);
				return {
					type: "image",
					source: {
						type: "base64",
						data: source.data,
						media_type: source.media_type,
					},
					...cache(value),
				};
			}
			case "tool_use":
				if (
					nested ||
					!validCallId(value.id) ||
					!validFunctionName(value.name) ||
					!isRecord(value.input)
				)
					break;
				return {
					type: "tool_use",
					id: value.id,
					name: value.name,
					input: value.input,
					...cache(value),
				};
			case "tool_result":
				if (nested || !validCallId(value.tool_use_id)) break;
				return {
					type: "tool_result",
					tool_use_id: value.tool_use_id,
					content: blocks(value.content, true),
					...(value.is_error === true ? { is_error: true } : {}),
					...cache(value),
				};
			case "thinking":
				if (
					nested ||
					typeof value.thinking !== "string" ||
					typeof value.signature !== "string"
				)
					break;
				return {
					type: "thinking",
					thinking: value.thinking,
					signature: value.signature,
				};
			case "redacted_thinking":
				if (nested || typeof value.data !== "string") break;
				return { type: "redacted_thinking", data: value.data };
		}
		throw new Error("Native tools or remote media refused");
	});
}
/**
 * A mid-conversation system message's content: text only. The guest already writes the top-level
 * system prompt and every user turn, so its text here carries no more authority. Its tool changes
 * are refused in the API's wording, so Claude Code resends the tools whole instead.
 */
function systemContent(raw: unknown, index: number): unknown[] | string {
	if (typeof raw === "string") return raw;
	if (!Array.isArray(raw) || raw.length > 256)
		throw new Error("Invalid content");
	return raw.map((value: unknown, block) => {
		if (
			isRecord(value) &&
			value.type === "text" &&
			typeof value.text === "string"
		)
			return { type: "text", text: value.text, ...cache(value) };
		const type = isRecord(value) ? String(value.type) : typeof value;
		throw new Error(
			`messages.${index}.content.${block}: Input tag '${type}' found using 'type' does not match any of the expected tags: 'text'`,
		);
	});
}
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Highest effort and extended-thinking budget the host-judged level allows. */
const CEILINGS: Record<PiThinkingLevel, { effort: number; budget: number }> = {
	low: { effort: 0, budget: 2048 },
	medium: { effort: 1, budget: 8192 },
	high: { effort: 2, budget: 16384 },
	xhigh: { effort: 4, budget: 32768 },
};

/** Reconstruct ordinary Anthropic text/base64-image/custom-tool traffic; never forward opaque guest objects. */
export function piModelInput(
	input: Record<string, unknown>,
	model: string,
	countTokens: boolean,
	maxOutputTokens = 128_000,
	/** The host-judged level for the admitted turn; the guest can only go lower. */
	thinking: PiThinkingLevel = "low",
): Record<string, unknown> {
	if (!Array.isArray(input.messages) || input.messages.length > 2000)
		throw new Error("Invalid messages");
	const ceiling = CEILINGS[thinking];
	/** An effort the guest asks for, at most the host-judged level allows; -1 when none. */
	const cappedEffort = (config: unknown): number => {
		const asked = isRecord(config)
			? EFFORTS.indexOf(config.effort as (typeof EFFORTS)[number])
			: -1;
		return asked >= 0 ? Math.min(asked, ceiling.effort) : -1;
	};
	const body: Record<string, unknown> = {
		model,
		messages: input.messages.map((message: unknown, index) => {
			if (!isRecord(message)) throw new Error("Invalid message");
			// Claude Code sends each turn's environment as a mid-conversation system message.
			if (message.role === "system") {
				const effort = cappedEffort(message.output_config);
				return {
					role: "system",
					content: systemContent(message.content, index),
					...(message.clear_at === "next_user_message" ||
					message.clear_at === "never"
						? { clear_at: message.clear_at }
						: {}),
					...(effort >= 0
						? { output_config: { effort: EFFORTS[effort] } }
						: {}),
				};
			}
			// Worded as the Anthropic API words it, so a client recognizes the refusal.
			if (!["user", "assistant"].includes(String(message.role)))
				throw new Error(
					`messages.${index}: Unexpected role ${JSON.stringify(String(message.role))}: the input message role must be "user", "assistant" or "system"`,
				);
			return { role: message.role, content: blocks(message.content) };
		}),
	};
	if (input.system !== undefined) body.system = blocks(input.system, true);
	if (input.tools !== undefined) {
		if (!Array.isArray(input.tools) || input.tools.length > 128)
			throw new Error("Invalid tools");
		body.tools = input.tools.map((tool: unknown) => {
			if (
				!isRecord(tool) ||
				(tool.type !== undefined && tool.type !== "custom") ||
				!validFunctionName(tool.name) ||
				!isRecord(tool.input_schema) ||
				!localSchema(tool.input_schema) ||
				(tool.description !== undefined && typeof tool.description !== "string")
			)
				throw new Error("Remote schema or native tool refused");
			return {
				name: tool.name,
				input_schema: tool.input_schema,
				...(tool.description ? { description: tool.description } : {}),
				...cache(tool),
			};
		});
	}
	if (input.tool_choice !== undefined) {
		const choice = input.tool_choice;
		if (
			!isRecord(choice) ||
			!["auto", "any", "tool", "none"].includes(String(choice.type)) ||
			(choice.type === "tool" && !validFunctionName(choice.name))
		)
			throw new Error("Invalid tool choice");
		body.tool_choice = {
			type: choice.type,
			...(choice.type === "tool" ? { name: choice.name } : {}),
			...(choice.disable_parallel_tool_use === true
				? { disable_parallel_tool_use: true }
				: {}),
		};
	}
	if (isRecord(input.thinking)) {
		if (
			input.thinking.type === "adaptive" ||
			input.thinking.type === "disabled"
		)
			body.thinking = { type: input.thinking.type };
		else if (
			input.thinking.type === "enabled" &&
			Number.isSafeInteger(input.thinking.budget_tokens) &&
			Number(input.thinking.budget_tokens) >= 1024
		)
			body.thinking = {
				type: "enabled",
				budget_tokens: Math.min(
					Number(input.thinking.budget_tokens),
					ceiling.budget,
					maxOutputTokens - 1,
				),
			};
		else throw new Error("Invalid thinking");
	}
	const asked = cappedEffort(input.output_config);
	// Adaptive thinking without an explicit effort runs at the model's default, so the host caps it too.
	const effort =
		asked >= 0
			? asked
			: isRecord(body.thinking) &&
					body.thinking.type === "adaptive" &&
					ceiling.effort < 2
				? ceiling.effort
				: -1;
	if (effort >= 0) body.output_config = { effort: EFFORTS[effort] };
	if (!countTokens) {
		const budget =
			isRecord(body.thinking) && typeof body.thinking.budget_tokens === "number"
				? body.thinking.budget_tokens
				: 0;
		body.max_tokens = Math.max(
			budget + 1,
			Math.min(
				Number.isSafeInteger(input.max_tokens) && Number(input.max_tokens) > 0
					? Number(input.max_tokens)
					: 16384,
				maxOutputTokens,
			),
		);
		body.stream = input.stream === true;
		for (const key of ["temperature", "top_p", "top_k"])
			if (typeof input[key] === "number" && Number.isFinite(input[key]))
				body[key] = input[key];
		if (
			Array.isArray(input.stop_sequences) &&
			input.stop_sequences.length <= 16 &&
			input.stop_sequences.every(
				(s) => typeof s === "string" && s.length <= 1000,
			)
		)
			body.stop_sequences = input.stop_sequences;
	}
	return body;
}
