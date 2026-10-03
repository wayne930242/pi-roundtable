// Runs one schedule's precheck script inside its sealed container and prints its answer.
// The script is untrusted: the container, not this file, is the boundary.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROKER_PATH, boundedText, isRecord } from "../src/protocol.ts";
import { unixBrokerRequest } from "./transport.ts";

interface Input {
	script: string;
	firedAt: string;
	timeZone: string;
	today: string;
	schedule: { id: number; title: string };
	servers: { name: string; tools: string[] }[];
}

function isInput(value: unknown): value is Input {
	return (
		isRecord(value) &&
		typeof value.script === "string" &&
		typeof value.firedAt === "string" &&
		typeof value.timeZone === "string" &&
		typeof value.today === "string" &&
		isRecord(value.schedule) &&
		Array.isArray(value.servers)
	);
}

const REFUSALS: Record<number, string> = {
	403: "that server or tool is not granted to this script",
	404: "that server is not granted to this script",
	410: "the run ended",
	409: "the script made two MCP calls at once; await each before the next",
	429: "the script made too many MCP calls",
};

/** The MCP calls a script makes, each through the host's broker. */
function mcpClient(servers: Input["servers"]) {
	const call = async (
		server: string,
		tool: string,
		args: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> => {
		const granted = servers.find((s) => s.name === server);
		if (!granted?.tools.includes(tool))
			throw new Error(`${server}/${tool} is not granted to this script`);
		const { status, body } = await unixBrokerRequest(
			`/mcp/${server}`,
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: tool, arguments: args },
			},
			// Tests run the worker outside a container; there the host sets only HOME.
			process.env.PRECHECK_BROKER_SOCKET ?? BROKER_PATH,
		);
		if (status !== 200)
			throw new Error(
				`${server}/${tool}: ${REFUSALS[status] ?? "the broker call failed"}`,
			);
		if (!isRecord(body)) throw new Error(`${server}/${tool}: no answer`);
		if (isRecord(body.error))
			throw new Error(`${server}/${tool}: ${String(body.error.message)}`);
		const result = body.result;
		if (!isRecord(result)) throw new Error(`${server}/${tool}: no result`);
		if (result.isError === true)
			throw new Error(`${server}/${tool}: ${firstText(result) ?? "failed"}`);
		return result;
	};
	return {
		call,
		/** The result's structured content, or its first text content parsed as JSON (or as text). */
		async json(
			server: string,
			tool: string,
			args: Record<string, unknown> = {},
		): Promise<unknown> {
			const result = await call(server, tool, args);
			if (result.structuredContent !== undefined)
				return result.structuredContent;
			const text = firstText(result);
			if (text === undefined) return undefined;
			try {
				return JSON.parse(text);
			} catch {
				return text;
			}
		},
	};
}

function firstText(result: Record<string, unknown>): string | undefined {
	const content = Array.isArray(result.content) ? result.content : [];
	const text = content.find(
		(item): item is { text: string } =>
			isRecord(item) && item.type === "text" && typeof item.text === "string",
	);
	return text?.text;
}

function message(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(
		0,
		1000,
	);
}

/** Runs the script and returns what to print; never throws. */
async function answer(): Promise<string> {
	try {
		const input: unknown = JSON.parse(
			await boundedText(Bun.stdin.stream(), 64 * 1024),
		);
		if (!isInput(input)) throw new Error("invalid precheck input");
		// stdout carries only the answer; whatever the script logs goes to stderr.
		for (const level of ["log", "info", "debug", "warn"] as const)
			console[level] = console.error;
		const path = join(tmpdir(), `precheck-${randomUUID()}.mjs`);
		await Bun.write(path, input.script);
		let module: unknown;
		try {
			module = await import(path);
		} finally {
			await rm(path, { force: true });
		}
		const check = isRecord(module) ? module.default : undefined;
		if (typeof check !== "function")
			throw new Error("the script has no default export function");
		const result: unknown = await check({
			mcp: mcpClient(input.servers),
			firedAt: new Date(input.firedAt),
			timeZone: input.timeZone,
			today: input.today,
			schedule: input.schedule,
		});
		return JSON.stringify({ ok: true, result: result ?? null });
	} catch (error) {
		return JSON.stringify({ ok: false, error: message(error) });
	}
}

// Exit once the answer is written, even if the script left timers or sockets behind.
await Bun.write(Bun.stdout, await answer());
process.exit(0);
