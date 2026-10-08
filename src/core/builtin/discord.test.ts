import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interaction } from "discord.js";
import type { ConversationPort } from "../contract/channels.ts";
import type { ChatSurface } from "../contract/surface.ts";
import type { ComposedCommands } from "../discord/compose-commands.ts";
import type {
	InteractionContribution,
	InteractionModule,
} from "../discord/interaction-module.ts";
import { STOP_BUTTON_ID } from "../discord/stop-button.ts";
import { PluginError } from "../errors.ts";
import { silentLogger } from "../log.ts";
import type { PluginContext } from "../plugin.ts";
import { IDENTITY } from "../services.ts";
import { speakerPolicy } from "../speakers.ts";
import { mapIdentity } from "../testing/map-identity.ts";
import { DISCORD, type DiscordServices, discordPlugin } from "./discord.ts";

const OPTIONS = {
	token: "token",
	ownerId: "1",
	ownerName: "Ada",
	speakers: speakerPolicy({ owners: ["1"] }),
	rootCommand: "bot",
};

/** The Discord plugin set up alone; `compose` runs its preflight, which hands the commands to its surface. */
async function setUp(
	conversations: Partial<ConversationPort> = {},
	options: { refusalHint?: string } = {},
	identity?: ReturnType<typeof mapIdentity>,
): Promise<{
	services: string[];
	surfaces: string[];
	surface: ChatSurface & {
		setCommands(composed: ComposedCommands): void;
	};
	provided: DiscordServices;
	modules(): InteractionModule[];
	preflight(): Promise<void>;
}> {
	let provided: DiscordServices | undefined;
	const plugin = discordPlugin({
		...OPTIONS,
		dataDir: mkdtempSync(join(tmpdir(), "roundtable-discord-")),
		...options,
	});
	const contribution = await plugin.setup({
		logger: silentLogger(),
		queue: {},
		conversations,
		services: {
			provide: (key: { id: string }, value: DiscordServices) => {
				if (key.id === DISCORD.id) provided = value;
			},
			find: (key: { id: string }) =>
				key.id === IDENTITY.id ? identity : undefined,
		},
	} as unknown as PluginContext);
	if (!provided) throw new Error("the discord plugin provided no DISCORD");
	const surface = contribution.surfaces?.[0] as ChatSurface & {
		setCommands(composed: ComposedCommands): void;
	};
	let composed: ComposedCommands | undefined;
	surface.setCommands = (given) => {
		composed = given;
	};
	return {
		services: (contribution.services ?? []).map(({ name }) => name),
		surfaces: (contribution.surfaces ?? []).map(({ surface }) => surface),
		surface,
		provided,
		modules: () => composed?.modules ?? [],
		preflight: async () => plugin.preflight?.(),
	};
}

test("the plugin contributes the Discord surface, and its one service only sweeps threads once the surface is up", async () => {
	const { services, surfaces } = await setUp();
	expect(surfaces).toEqual(["discord"]);
	expect(services).toEqual(["threads"]);
});

test("the Discord surface hands out the owner's cards for its channels", async () => {
	const { surface } = await setUp();
	expect(typeof surface.prompts?.("discord:555")?.confirm).toBe("function");
});

test("the plugin provides the connection, the registrar, the guard and the threads, and no cards", async () => {
	const { provided } = await setUp();
	expect(Object.keys(provided).sort()).toEqual([
		"commands",
		"connection",
		"guard",
		"threads",
	]);
	expect(provided.guard.root).toBe("bot");
	expect(provided.guard.isOwner({ user: { id: "1" } })).toBe(true);
	expect(provided.guard.isOwner({ user: { id: "2" } })).toBe(false);
});

test("with the identity service, the guard lets every owner use the owner's commands, and no member", async () => {
	const { provided } = await setUp(
		{},
		{},
		mapIdentity({ owners: ["1", "6"], members: { users: ["3"] } }),
	);
	expect(await provided.guard.allows({ user: { id: "1" } })).toBe(true);
	expect(await provided.guard.allows({ user: { id: "6" } })).toBe(true);
	expect(await provided.guard.allows({ user: { id: "3" } })).toBe(false);
	// The deprecated check stays the primary owner's.
	expect(provided.guard.isOwner({ user: { id: "6" } })).toBe(false);
	const alone = (await setUp()).provided.guard;
	expect(await alone.allows({ user: { id: "1" } })).toBe(true);
	expect(await alone.allows({ user: { id: "6" } })).toBe(false);
});

const module = (commands: string[] = []): InteractionModule => ({
	commands: () =>
		commands.map((name) => ({ name, description: name, type: 1 as const })),
	handle: async () => false,
});

test("commands added during setup are composed under the root in the preflight, after the plugin's own", async () => {
	const { provided, surface, preflight } = await setUp();
	let composed: ComposedCommands | undefined;
	surface.setCommands = (given) => {
		composed = given;
	};
	const add: InteractionContribution = {
		module: module(["roll"]),
		rootOptions: [{ type: 1, name: "help", description: "help" }],
	};
	provided.commands.add(add);
	await preflight();
	expect(composed?.commands.map((command) => command.name)).toEqual([
		"roll",
		"bot",
	]);
	// The owner's cards and the stop button answer first, as they always have.
	expect(composed?.modules).toHaveLength(3);
	expect(composed?.modules[2]).toBe(add.module);
});

test("the preflight refuses a clash before any service starts, and a late add is refused", async () => {
	const { provided, preflight } = await setUp();
	provided.commands.add({ module: module(["roll"]) });
	provided.commands.add({ module: module(["roll"]) });
	await expect(preflight()).rejects.toThrow("/roll is registered twice");
	expect(() => provided.commands.add({ module: module(["late"]) })).toThrow(
		PluginError,
	);
});

test("a module that registers the root itself is refused in the preflight", async () => {
	const { provided, preflight } = await setUp();
	provided.commands.add({ module: module(["bot"]) });
	await expect(preflight()).rejects.toThrow(
		"/bot is composed from subcommands; a module may not register it",
	);
});

test("adding after the preflight names the fix", async () => {
	const { provided, preflight } = await setUp();
	await preflight();
	expect(() => provided.commands.add({ module: module() })).toThrow(
		"commands can be added only while plugins set up",
	);
});

test("the guard carries the refusal hint it was given", async () => {
	const { provided } = await setUp({}, { refusalHint: " Dice: /roll." });
	expect(provided.guard.refusalHint).toBe(" Dice: /roll.");
	expect((await setUp()).provided.guard.refusalHint).toBeUndefined();
});

/** A press of a button by a user in channel 555, recording how it was answered. */
function press(userId: string, customId: string) {
	const replies: string[] = [];
	const interaction = {
		isButton: () => true,
		customId,
		user: { id: userId },
		channelId: "555",
		reply: async (answer: { content: string }) => {
			replies.push(answer.content);
		},
	} as unknown as Interaction;
	return { interaction, replies };
}

/** Whichever of the modules answers the interaction, as the surface asks them in order. */
async function answered(
	modules: InteractionModule[],
	interaction: Interaction,
): Promise<boolean> {
	for (const module of modules)
		if (await module.handle(interaction)) return true;
	return false;
}

test("the stop button core posts is answered by the Discord built-in, for the owner only", async () => {
	const stopped: string[] = [];
	let running = true;
	const { modules: composedModules, preflight } = await setUp({
		stop: (channel) => {
			stopped.push(channel);
			return running;
		},
	});
	await preflight();
	const modules = composedModules();

	const owner = press("1", STOP_BUTTON_ID);
	expect(await answered(modules, owner.interaction)).toBe(true);
	expect(stopped).toEqual(["discord:555"]);
	expect(owner.replies).toEqual(["Stopped."]);

	running = false;
	const again = press("1", STOP_BUTTON_ID);
	await answered(modules, again.interaction);
	expect(again.replies).toEqual(["Nothing is running right now."]);

	const stranger = press("2", STOP_BUTTON_ID);
	await answered(modules, stranger.interaction);
	expect(stopped).toHaveLength(2);
	expect(stranger.replies).toEqual(["Only Roundtable's owner can stop it."]);
});

test("another button is not the stop button's", async () => {
	const { modules: composedModules, preflight } = await setUp({
		stop: () => true,
	});
	await preflight();
	const modules = composedModules();
	const other = press("1", "somebody:else");
	expect(await answered(modules, other.interaction)).toBe(false);
	expect(other.replies).toEqual([]);
});
