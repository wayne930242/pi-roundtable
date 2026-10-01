import { expect, test } from "bun:test";
import { fakeDiscord, testPlugin } from "pi-roundtable/testing";
import { ping } from "./interactions.ts";

/** The parts of a Discord interaction the module reads. */
function fake(subcommand: string, replies: string[]) {
	return {
		isChatInputCommand: () => true,
		options: { getSubcommand: () => subcommand },
		reply: async (text: string) => {
			replies.push(text);
		},
	} as never;
}

test("the module answers /roundtable ping and ignores other subcommands", async () => {
	const discord = fakeDiscord();
	const harness = await testPlugin(ping, { services: [discord.service] });
	const [added] = discord.added();
	expect(added?.rootOptions?.map((option) => option.name)).toEqual(["ping"]);
	const replies: string[] = [];
	expect(await added?.module.handle(fake("ping", replies))).toBe(true);
	expect(await added?.module.handle(fake("other", replies))).toBe(false);
	expect(replies).toEqual(["pong"]);
	await harness.stop();
});

test("the tree Discord would register has the subcommand under the root", async () => {
	const discord = fakeDiscord();
	await (await testPlugin(ping, { services: [discord.service] })).stop();
	const { commands } = discord.compose();
	expect(commands.map((command) => command.name)).toEqual(["roundtable"]);
	expect(commands[0]?.options?.map((option) => option.name)).toEqual(["ping"]);
});
