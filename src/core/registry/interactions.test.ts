import { describe, expect, test } from "bun:test";
import { InteractionContextType } from "discord.js";
import type { InteractionModule, RootOption } from "../contract/discord.ts";
import { PluginError } from "../errors.ts";
import { composeInteractions } from "./interactions.ts";

const ROOT = {
	name: "roundtable",
	description: "control",
	contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
};

function module(...names: string[]): InteractionModule {
	return {
		commands: () =>
			names.map((name) => ({ name, description: name, type: 1 as const })),
		handle: async () => false,
	};
}

const sub = (name: string): RootOption => ({
	type: 1,
	name,
	description: name,
});

describe("composeInteractions", () => {
	test("puts every contribution's subcommands under one root, after the modules' own commands", () => {
		const a = module("roll");
		const b = module();
		const composed = composeInteractions(ROOT, [
			{ module: b, rootOptions: [sub("help"), sub("status")] },
			{ module: a },
			{ module: module(), rootOptions: [sub("party")] },
		]);
		expect(composed.commands.map((c) => c.name)).toEqual([
			"roll",
			"roundtable",
		]);
		const root = composed.commands[1];
		expect(root?.options?.map((o) => o.name)).toEqual([
			"help",
			"status",
			"party",
		]);
		expect(root?.contexts).toEqual(ROOT.contexts);
		expect(composed.modules[0]).toBe(b);
		expect(composed.modules[1]).toBe(a);
	});

	test("registers no root without subcommands", () => {
		const composed = composeInteractions(ROOT, [{ module: module("dice") }]);
		expect(composed.commands.map((c) => c.name)).toEqual(["dice"]);
	});

	test("refuses a subcommand added twice, a command registered twice, and a module registering the root", () => {
		const refused = (build: () => unknown) => {
			try {
				build();
				return undefined;
			} catch (error) {
				return error;
			}
		};
		expect(
			refused(() =>
				composeInteractions(ROOT, [
					{ module: module(), rootOptions: [sub("mcp")] },
					{ module: module(), rootOptions: [sub("mcp")] },
				]),
			),
		).toBeInstanceOf(PluginError);
		expect(
			refused(() =>
				composeInteractions(ROOT, [
					{ module: module("roll") },
					{ module: module("roll") },
				]),
			),
		).toBeInstanceOf(PluginError);
		expect(
			refused(() =>
				composeInteractions(ROOT, [{ module: module("roundtable") }]),
			),
		).toBeInstanceOf(PluginError);
	});
});
