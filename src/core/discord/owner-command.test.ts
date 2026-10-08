import { describe, expect, test } from "bun:test";
import type { Interaction } from "discord.js";
import type { ActorFacts } from "../identity/actor-facts.ts";
import { silentLogger } from "../log.ts";
import { mapIdentity } from "../testing/map-identity.ts";
import { commandGuard, ownerCommandModule } from "./owner-command.ts";
import { STOP_BUTTON_ID, stopButtonModule } from "./stop-button.ts";

const OWNER = "100000000000000001";
const SECOND_OWNER = "100000000000000006";
const MEMBER = "100000000000000003";
const STRANGER = "100000000000000009";

/** Two owners, as the CLI may grant a second one, and a member; it records whom it resolved. */
function twoOwners() {
	const map = mapIdentity({
		owners: [OWNER, SECOND_OWNER],
		members: { users: [MEMBER] },
	});
	const resolved: string[] = [];
	return {
		resolved,
		identity: {
			...map,
			resolve: (facts: ActorFacts) => {
				resolved.push(facts.subject);
				return map.resolve(facts);
			},
		},
	};
}

/** A `/roundtable sandbox on` from the user, recording what it was answered. */
function command(user: string, kind: "command" | "autocomplete" = "command") {
	const replies: unknown[] = [];
	const responses: unknown[] = [];
	const fixture = {
		user: { id: user, username: `user ${user}`, globalName: null },
		commandName: "roundtable",
		deferred: false,
		replied: false,
		isAutocomplete: () => kind === "autocomplete",
		isChatInputCommand: () => kind === "command",
		isRepliable: () => true,
		options: {
			getSubcommandGroup: () => "sandbox",
			getSubcommand: () => "on",
		},
		deferReply: async () => {
			fixture.deferred = true;
		},
		reply: async (body: unknown) => {
			replies.push(body);
		},
		editReply: async (body: unknown) => {
			replies.push(body);
		},
		respond: async (choices: unknown) => {
			responses.push(choices);
		},
	};
	// SAFETY: this fixture supplies every member ownerCommandModule and the guard read.
	return { interaction: fixture as unknown as Interaction, replies, responses };
}

/** The `sandbox` group of the root command, recording who ran it. */
function sandboxModule(guard: ReturnType<typeof commandGuard>) {
	const ran: string[] = [];
	const completed: string[] = [];
	const module = ownerCommandModule(guard, {
		owns: (group) => group === "sandbox",
		autocomplete: async (interaction) => {
			completed.push(interaction.user.id);
		},
		command: async (interaction) => {
			ran.push(interaction.user.id);
		},
	});
	return { module, ran, completed };
}

const guardOf = (identity?: ReturnType<typeof twoOwners>["identity"]) =>
	commandGuard({
		ownerId: OWNER,
		root: "roundtable",
		logger: silentLogger(),
		...(identity ? { identity } : {}),
	});

describe("the owner's commands with more than one owner", () => {
	test("a second owner uses the owner's commands and their autocomplete; a member is refused as before", async () => {
		const { identity } = twoOwners();
		const { module, ran, completed } = sandboxModule(guardOf(identity));
		await module.handle(command(SECOND_OWNER).interaction);
		await module.handle(command(OWNER).interaction);
		expect(ran).toEqual([SECOND_OWNER, OWNER]);
		await module.handle(command(SECOND_OWNER, "autocomplete").interaction);
		expect(completed).toEqual([SECOND_OWNER]);

		const member = command(MEMBER);
		await module.handle(member.interaction);
		expect(ran).toEqual([SECOND_OWNER, OWNER]);
		// The refusal a single owner's guard gives.
		const single = sandboxModule(guardOf());
		const before = command(MEMBER);
		await single.module.handle(before.interaction);
		expect(JSON.stringify(member.replies)).toBe(JSON.stringify(before.replies));
		const blank = command(MEMBER, "autocomplete");
		await module.handle(blank.interaction);
		expect(blank.responses).toEqual([[]]);
	});

	test("an owner revoked since is refused as they run it", async () => {
		const { identity } = twoOwners();
		let revoked = false;
		const guard = guardOf({
			...identity,
			resolve: async (facts) => {
				const speaker = await identity.resolve(facts);
				return speaker && revoked && speaker.id === SECOND_OWNER
					? { ...speaker, tier: "admin" }
					: speaker;
			},
		});
		const { module, ran } = sandboxModule(guard);
		revoked = true;
		await module.handle(command(SECOND_OWNER).interaction);
		expect(ran).toEqual([]);
	});

	test("a stranger's command is refused without resolving them, so it admits no one", async () => {
		const { identity, resolved } = twoOwners();
		const { module, ran } = sandboxModule(guardOf(identity));
		const stranger = command(STRANGER);
		await module.handle(stranger.interaction);
		expect(ran).toEqual([]);
		expect(stranger.replies).toHaveLength(1);
		expect(resolved).toEqual([]);
	});

	test("the primary owner is the owner without an identity service, and needs no resolving", async () => {
		const { identity, resolved } = twoOwners();
		const { module, ran } = sandboxModule(guardOf());
		await module.handle(command(SECOND_OWNER).interaction);
		await module.handle(command(OWNER).interaction);
		expect(ran).toEqual([OWNER]);
		const withIdentity = sandboxModule(guardOf(identity));
		await withIdentity.module.handle(command(OWNER).interaction);
		expect(withIdentity.ran).toEqual([OWNER]);
		expect(resolved).toEqual([]);
	});

	test("a second owner stops a channel's turn with the stop button; a member may not", async () => {
		const { identity } = twoOwners();
		const stopped: string[] = [];
		const module = stopButtonModule({
			guard: guardOf(identity),
			conversations: {
				stop: (channel) => {
					stopped.push(channel);
					return true;
				},
			},
		});
		const press = (user: string) => {
			const replies: string[] = [];
			// SAFETY: the stop button reads only these members of an interaction.
			const interaction = {
				isButton: () => true,
				customId: STOP_BUTTON_ID,
				channelId: "555",
				user: { id: user },
				reply: async (answer: { content: string }) => {
					replies.push(answer.content);
				},
			} as unknown as Interaction;
			return { interaction, replies };
		};
		await module.handle(press(MEMBER).interaction);
		expect(stopped).toEqual([]);
		await module.handle(press(SECOND_OWNER).interaction);
		expect(stopped).toEqual(["discord:555"]);
	});
});
