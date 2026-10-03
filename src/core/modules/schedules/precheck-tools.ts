import { parse } from "@babel/parser";
import type { Node, Program } from "@babel/types";
import { ScheduleError } from "../../domain/errors.ts";
import {
	type HoldCheck,
	type HoldContext,
	type HoldRule,
	higherTier,
} from "../../holds.ts";
import { messages } from "../../i18n/index.ts";
import type { Tier } from "../../speakers.ts";
import type { ToolTiers } from "../../tool-tiers.ts";
import type { PrecheckRegistry } from "./prechecks.ts";

/**
 * An MCP tool a schedule's precheck script may call, as approved when the script was saved. The
 * runner lets the script call nothing else.
 */
export interface PrecheckTool {
	server: string;
	tool: string;
	/** What the host's hold rules said a call of it would do; set, the owner approved it on saving the script. */
	held?: string;
}

/** One `mcp.call` or `mcp.json` in a script, with its arguments when they are written out literally. */
export interface PrecheckScriptCall {
	server: string;
	tool: string;
	/** Undefined when the script computes them, so they are known only when it runs. */
	args?: Record<string, unknown>;
}

const NOT_LITERAL = Symbol("not literal");

/** A value written out in the script itself. */
type Literal =
	| string
	| number
	| boolean
	| null
	| Literal[]
	| { [key: string]: Literal };

/** The value of an expression written out as JSON-like literals, or NOT_LITERAL. */
function literal(node: Node | null | undefined): Literal | typeof NOT_LITERAL {
	if (!node) return NOT_LITERAL;
	switch (node.type) {
		case "StringLiteral":
		case "NumericLiteral":
		case "BooleanLiteral":
			return node.value;
		case "NullLiteral":
			return null;
		case "TemplateLiteral":
			return node.expressions.length === 0
				? node.quasis.map((q) => q.value.cooked ?? q.value.raw).join("")
				: NOT_LITERAL;
		case "UnaryExpression":
			return node.operator === "-" && node.argument.type === "NumericLiteral"
				? -node.argument.value
				: NOT_LITERAL;
		case "ArrayExpression": {
			const items: Literal[] = [];
			for (const item of node.elements) {
				const value =
					item && item.type !== "SpreadElement" ? literal(item) : NOT_LITERAL;
				if (value === NOT_LITERAL) return NOT_LITERAL;
				items.push(value);
			}
			return items;
		}
		case "ObjectExpression": {
			const entries: [string, Literal][] = [];
			for (const property of node.properties) {
				if (property.type !== "ObjectProperty" || property.computed)
					return NOT_LITERAL;
				const key =
					property.key.type === "Identifier"
						? property.key.name
						: property.key.type === "StringLiteral"
							? property.key.value
							: undefined;
				const value = literal(property.value);
				if (key === undefined || value === NOT_LITERAL) return NOT_LITERAL;
				entries.push([key, value]);
			}
			return Object.fromEntries(entries);
		}
		default:
			return NOT_LITERAL;
	}
}

const REACH =
	"a precheck script may use mcp only as mcp.call(server, tool, args) or mcp.json(server, tool, args), with server and tool written as strings, after taking it from the context as ({ mcp }) or const { mcp } = context";

function isNode(value: unknown): value is Node {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

/** Every node under `node`, with the key it sits under in its parent. */
function* walk(
	node: Node,
	parent?: Node,
	key?: string,
): Generator<[Node, Node | undefined, string | undefined]> {
	yield [node, parent, key];
	for (const [childKey, value] of Object.entries(node)) {
		if (
			childKey === "loc" ||
			childKey === "leadingComments" ||
			childKey === "trailingComments" ||
			childKey === "innerComments"
		)
			continue;
		if (Array.isArray(value)) {
			for (const item of value)
				if (isNode(item)) yield* walk(item, node, childKey);
		} else if (isNode(value)) yield* walk(value, node, childKey);
	}
}

/** The longest precheck script a schedule may carry, in characters. */
export const PRECHECK_SCRIPT_CHARS = 8_000;

/**
 * Reads a precheck script without running it: a JavaScript module within the size limit whose
 * default export is what the runner calls, and the MCP calls it makes. Server and tool must be
 * written as strings, and `mcp` may be used only for those calls, so the calls are known before it
 * runs; anything else throws ScheduleError with what to fix. The runner still lets the script call
 * only the tools approved for it.
 */
export function readPrecheckScript(script: unknown): {
	script: string;
	calls: PrecheckScriptCall[];
} {
	if (typeof script !== "string" || !script.trim())
		throw new ScheduleError(
			"precheck_script must be a JavaScript module with a default export",
		);
	if (script.length > PRECHECK_SCRIPT_CHARS)
		throw new ScheduleError(
			`precheck_script is ${script.length} characters; keep it within ${PRECHECK_SCRIPT_CHARS}`,
		);
	let program: Program;
	try {
		program = parse(script, {
			sourceType: "module",
			errorRecovery: false,
		}).program;
	} catch (error) {
		throw new ScheduleError(
			`precheck_script does not parse as a JavaScript module: ${error instanceof Error ? error.message || error.name : String(error)}`,
		);
	}
	const exportsDefault = program.body.some(
		(node) =>
			node.type === "ExportDefaultDeclaration" ||
			(node.type === "ExportNamedDeclaration" &&
				node.specifiers.some((specifier) =>
					specifier.exported.type === "Identifier"
						? specifier.exported.name === "default"
						: specifier.exported.value === "default",
				)),
	);
	if (!exportsDefault)
		throw new ScheduleError(
			"precheck_script needs a default export: export default async (context) => ({ wake: false, note }) or ({ wake: true, context })",
		);
	return { script, calls: mcpCalls(program) };
}

/** Checks a precheck script without running it, as `readPrecheckScript` does; returns it. */
export function checkPrecheckScript(script: unknown): string {
	return readPrecheckScript(script).script;
}

function mcpCalls(program: Program): PrecheckScriptCall[] {
	const calls: PrecheckScriptCall[] = [];
	const allowed = new Set<Node>();
	for (const [node] of walk(program)) {
		if (
			node.type !== "CallExpression" ||
			node.callee.type !== "MemberExpression" ||
			node.callee.computed ||
			node.callee.object.type !== "Identifier" ||
			node.callee.object.name !== "mcp" ||
			node.callee.property.type !== "Identifier" ||
			!["call", "json"].includes(node.callee.property.name)
		)
			continue;
		const [serverArg, toolArg, argsArg, ...rest] = node.arguments;
		const server = literal(serverArg);
		const tool = literal(toolArg);
		if (typeof server !== "string" || typeof tool !== "string")
			throw new ScheduleError(
				`precheck_script computes a server or tool name for mcp.${node.callee.property.name}; ${REACH}`,
			);
		if (rest.length > 0)
			throw new ScheduleError(
				`precheck_script passes mcp.${node.callee.property.name} more than three arguments; ${REACH}`,
			);
		const args = argsArg === undefined ? {} : literal(argsArg);
		calls.push({
			server,
			tool,
			...(args !== NOT_LITERAL &&
			typeof args === "object" &&
			args !== null &&
			!Array.isArray(args)
				? { args }
				: {}),
		});
		allowed.add(node.callee.object);
	}
	for (const [node, parent, key] of walk(program)) {
		if (node.type === "Identifier") {
			if (node.name === "arguments" || node.name === "eval")
				throw new ScheduleError(
					`precheck_script may not use ${node.name}; ${REACH}`,
				);
			if (node.name !== "mcp" || allowed.has(node)) continue;
			// `{ mcp }` taken from the context, under its own name.
			if (
				parent?.type === "ObjectProperty" &&
				key === "value" &&
				parent.key.type === "Identifier" &&
				parent.key.name === "mcp" &&
				!parent.computed
			)
				continue;
			// A property key named mcp, such as the `mcp` of `{ mcp }`, is no use of it.
			if (
				parent?.type === "ObjectProperty" &&
				key === "key" &&
				!parent.computed
			)
				continue;
			if (parent?.type === "MemberExpression" && key === "property") {
				if (!parent.computed)
					throw new ScheduleError(
						`precheck_script reads .mcp from an object; ${REACH}`,
					);
				continue;
			}
			throw new ScheduleError(
				`precheck_script uses mcp other than in a call; ${REACH}`,
			);
		}
		if (
			node.type === "ObjectProperty" &&
			!node.computed &&
			node.key.type === "Identifier" &&
			node.key.name === "mcp" &&
			parent?.type === "ObjectPattern" &&
			!(node.value.type === "Identifier" && node.value.name === "mcp")
		)
			throw new ScheduleError(`precheck_script renames mcp; ${REACH}`);
		if (
			node.type === "MemberExpression" &&
			node.computed &&
			node.property.type === "StringLiteral" &&
			node.property.value === "mcp"
		)
			throw new ScheduleError(`precheck_script reads ["mcp"]; ${REACH}`);
		if (
			node.type === "MemberExpression" &&
			node.computed &&
			node.object.type === "Identifier" &&
			node.object.name === "mcp"
		)
			throw new ScheduleError(`precheck_script uses mcp[...]; ${REACH}`);
	}
	return calls;
}

/**
 * The tools a script calls, each with what the host's hold rules say a call of it would do. A call
 * whose arguments are computed is judged by an empty input, or by a rule that says it may hold it.
 */
export function precheckScriptTools(
	script: unknown,
	options: {
		toolName: (server: string, tool: string) => string;
		holds: HoldCheck;
		context?: HoldContext;
	},
): PrecheckTool[] {
	const tools = new Map<string, PrecheckTool>();
	for (const call of readPrecheckScript(script).calls) {
		const name = options.toolName(call.server, call.tool);
		const context = options.context ?? {};
		let held: string | undefined;
		if (call.args) held = options.holds(name, call.args, context);
		else {
			held = options.holds(name, {}, context);
			const rule =
				held === undefined ? options.holds.mayHold?.(name) : undefined;
			if (rule !== undefined) held = messages().precheckToolMayHold(name, rule);
		}
		const key = `${call.server}\u0000${call.tool}`;
		const known = tools.get(key);
		if (!known)
			tools.set(key, {
				server: call.server,
				tool: call.tool,
				...(held ? { held } : {}),
			});
		else if (held && !known.held) known.held = held;
	}
	return [...tools.values()];
}

const SCHEDULE_TOOLS = new Set(["schedule_create", "schedule_update"]);

/**
 * Holds saving a precheck script that calls a held tool, so it is approved once, as each of its
 * calls would be, by someone who could approve those calls; the scheduled runs then do not ask
 * again. Contributed by the schedule tools' plugin; `holds` is the host's whole chain and `tiers`
 * the host's tool tiers, read when a call is judged.
 */
export function precheckScriptHoldRule(options: {
	prechecks: () => Partial<Pick<PrecheckRegistry, "scriptRunner">> | undefined;
	holds: () => HoldCheck;
	tiers?: () => ToolTiers;
}): HoldRule {
	let judging = false;
	/** The held tools a script being saved calls, by the names the hold rules know them by. */
	const heldCalls = (
		tool: string,
		input: Record<string, unknown>,
		context: HoldContext,
	): { name: string; held: string }[] => {
		const script = input.precheck_script;
		if (!SCHEDULE_TOOLS.has(tool) || typeof script !== "string" || judging)
			return [];
		const runner = options.prechecks()?.scriptRunner?.();
		if (!runner) return [];
		judging = true;
		try {
			return precheckScriptTools(script, {
				toolName: (server, name) => runner.toolName(server, name),
				holds: options.holds(),
				context,
			}).flatMap((t) =>
				t.held
					? [{ name: runner.toolName(t.server, t.tool), held: t.held }]
					: [],
			);
		} catch {
			// The tool refuses the script itself, with the reason.
			return [];
		} finally {
			judging = false;
		}
	};
	return {
		name: "precheck-scripts",
		describe(tool, input, context) {
			const held = heldCalls(tool, input, context);
			if (held.length === 0) return undefined;
			return messages().precheckScriptHeld(
				{
					...(typeof input.title === "string" && input.title
						? { title: input.title }
						: {}),
					...(typeof input.id === "number" ? { id: input.id } : {}),
				},
				held.map((call) => call.held),
			);
		},
		// Whoever approves must be able to approve each held call the script makes.
		approvalTier(tool, input, context) {
			const tiers = options.tiers?.();
			return heldCalls(tool, input, context).reduce<Tier | undefined>(
				(tier, call) =>
					higherTier(tier, tiers ? tiers.minTier(call.name) : "owner"),
				undefined,
			);
		},
	};
}
