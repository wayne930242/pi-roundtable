import { describe, expect, test } from "bun:test";
import { ChannelType, type Client, PermissionFlagsBits } from "discord.js";
import { DiscordOwnerOps } from "./owner-discord.ts";

const OWNER = "100";
const BOT = "200";
const {
	KickMembers,
	ManageNicknames,
	ManageRoles,
	Administrator,
	ViewChannel,
	ManageThreads,
	CreatePrivateThreads,
	SendMessagesInThreads,
} = PermissionFlagsBits;

class FakeRole {
	constructor(
		readonly id: string,
		readonly position: number,
	) {}
	comparePositionTo(other: FakeRole): number {
		return this.position - other.position;
	}
}

/** A member with a fixed permission set, a highest role, and recorded actions. */
class FakeMember {
	actions: string[] = [];
	readonly roles: {
		highest: FakeRole;
		add: (role: FakeRole) => Promise<void>;
	};
	readonly permissions: { has: (needed: bigint | bigint[]) => boolean };
	constructor(
		readonly id: string,
		readonly guild: FakeGuild,
		rank: number,
		granted: bigint[],
	) {
		this.roles = {
			highest: new FakeRole(`r${id}`, rank),
			add: async (role) => {
				this.actions.push(`add ${role.id}`);
			},
		};
		this.permissions = {
			has: (needed) =>
				granted.includes(Administrator) ||
				[needed].flat().every((p) => granted.includes(p)),
		};
	}
	async kick(): Promise<void> {
		this.actions.push("kick");
	}
	async setNickname(nickname: string | null): Promise<void> {
		this.actions.push(`nick ${nickname}`);
	}
}

class FakeGuild {
	readonly id = "1";
	ownerId = "999";
	readonly people = new Map<string, FakeMember>();
	readonly roleList = new Map<string, FakeRole>();
	readonly members = {
		fetch: async ({ user }: { user: string }) => {
			const member = this.people.get(user);
			if (!member) throw new Error("Unknown Member");
			return member;
		},
		fetchMe: async () => this.people.get(BOT),
	};
	readonly roles = {
		fetch: async (id: string) => this.roleList.get(id) ?? null,
	};
	readonly threadList = new Map<string, FakeThread>();
	readonly channels = {
		fetchActiveThreads: async () => ({ threads: this.threadList }),
	};
	add(id: string, rank: number, granted: bigint[]): FakeMember {
		const member = new FakeMember(id, this, rank, granted);
		this.people.set(id, member);
		return member;
	}
}

/** A thread whose permissions are its members' server permissions. */
class FakeThread {
	edits: object[] = [];
	added: string[] = [];
	readonly parentId = "50";
	readonly guildId: string;
	archived = false;
	locked = false;
	readonly messageCount = 0;
	readonly createdAt = new Date(0);
	readonly members = {
		add: async (id: string) => {
			this.added.push(id);
		},
	};
	constructor(
		readonly id: string,
		readonly guild: FakeGuild,
		readonly type: ChannelType,
		readonly name = "t",
	) {
		this.guildId = guild.id;
	}
	isThread() {
		return true;
	}
	permissionsFor(member: FakeMember) {
		return member.permissions;
	}
	async edit(options: object) {
		this.edits.push(options);
	}
}

/** A text channel whose new threads are recorded. */
class FakeTextChannel {
	readonly id = "50";
	readonly type = ChannelType.GuildText;
	readonly guildId: string;
	created: object[] = [];
	readonly threads = {
		create: async (options: { name: string; type?: ChannelType }) => {
			this.created.push(options);
			return new FakeThread(
				"60",
				this.guild,
				options.type ?? ChannelType.PublicThread,
				options.name,
			);
		},
	};
	constructor(readonly guild: FakeGuild) {
		this.guildId = guild.id;
	}
	isThread() {
		return false;
	}
	permissionsFor(member: FakeMember) {
		return member.permissions;
	}
}

function setup(ownerGrants: bigint[], botGrants: bigint[]) {
	const guild = new FakeGuild();
	const owner = guild.add(OWNER, 10, ownerGrants);
	const bot = guild.add(BOT, 20, botGrants);
	const guest = guild.add("300", 5, []);
	const text = new FakeTextChannel(guild);
	const channels = new Map<string, unknown>([["50", text]]);
	const client = {
		isReady: () => true,
		channels: { fetch: async (id: string) => channels.get(id) ?? null },
		guilds: {
			fetch: async (id: string) => {
				if (id !== guild.id) throw new Error("Unknown Guild");
				return guild;
			},
		},
	} as unknown as Client;
	return {
		ops: new DiscordOwnerOps(client, OWNER),
		guild,
		owner,
		bot,
		guest,
		text,
		channels,
	};
}

const kick = (userId: string) => ({ guildId: "1", userId });

describe("DiscordOwnerOps", () => {
	test("a kick runs when both hold the permission and the owner outranks the member", async () => {
		const { ops, guest } = setup([KickMembers], [KickMembers]);
		expect(await ops.run("discord_kick_member", kick("300"))).toEqual({
			userId: "300",
			kicked: true,
		});
		expect(guest.actions).toEqual(["kick"]);
	});

	test.each([
		["the owner lacks it", [], [KickMembers], "OWNER_PERMISSION_MISSING"],
		["the bot lacks it", [KickMembers], [], "BOT_PERMISSION_MISSING"],
	])(
		"a kick is refused when %s",
		async (_name, ownerGrants, botGrants, code) => {
			const { ops, guest } = setup(ownerGrants, botGrants);
			await expect(ops.run("discord_kick_member", kick("300"))).rejects.toThrow(
				code,
			);
			expect(guest.actions).toEqual([]);
		},
	);

	test("a member at or above the owner's highest role is refused unless the owner owns the server", async () => {
		const { ops, guild, guest } = setup([KickMembers], [KickMembers]);
		guest.roles.highest = new FakeRole("rtop", 10);
		await expect(ops.run("discord_kick_member", kick("300"))).rejects.toThrow(
			"HIERARCHY",
		);
		guild.ownerId = OWNER;
		await ops.run("discord_kick_member", kick("300"));
		expect(guest.actions).toEqual(["kick"]);
	});

	test("the owner must be in the server", async () => {
		const { ops, guild } = setup([KickMembers], [KickMembers]);
		guild.people.delete(OWNER);
		await expect(ops.run("discord_kick_member", kick("300"))).rejects.toThrow(
			"OWNER_NOT_IN_SERVER",
		);
	});

	test("a role above the owner cannot be given", async () => {
		const { ops, guild, guest } = setup([ManageRoles], [ManageRoles]);
		guild.roleList.set("low", new FakeRole("low", 3));
		guild.roleList.set("high", new FakeRole("high", 15));
		const give = (roleId: string) =>
			ops.run("discord_add_member_role", {
				guildId: "1",
				userId: "300",
				roleId,
			});
		await give("low");
		await expect(give("high")).rejects.toThrow("HIERARCHY");
		expect(guest.actions).toEqual(["add low"]);
	});

	test("the owner may rename the assistant even though it ranks higher", async () => {
		const { ops, bot } = setup([ManageNicknames], [ManageNicknames]);
		await ops.run("discord_set_nickname", {
			guildId: "1",
			userId: BOT,
			nickname: "Pika the Crow",
		});
		expect(bot.actions).toEqual(["nick Pika the Crow"]);
	});
});

describe("threads", () => {
	const threadMaker = [
		ViewChannel,
		CreatePrivateThreads,
		SendMessagesInThreads,
	];

	test("a private thread starts on its own and has the owner added", async () => {
		const { ops, text } = setup(threadMaker, threadMaker);
		expect(
			await ops.run("discord_create_thread", {
				channelId: "50",
				name: "plans",
				private: true,
			}),
		).toEqual({ id: "60", name: "plans", parentId: "50", private: true });
		expect(text.created).toMatchObject([
			{ name: "plans", type: ChannelType.PrivateThread },
		]);
	});

	test("a private thread from a message is refused before anything is made", async () => {
		const { ops, text } = setup(threadMaker, threadMaker);
		await expect(
			ops.run("discord_create_thread", {
				channelId: "50",
				name: "x",
				messageId: "70",
				private: true,
			}),
		).rejects.toThrow("INVALID_ARGUMENT");
		expect(text.created).toEqual([]);
	});

	test("editing a thread needs Manage Threads from both", async () => {
		const { ops, guild, channels } = setup([ViewChannel], [Administrator]);
		const thread = new FakeThread("61", guild, ChannelType.PublicThread);
		channels.set("61", thread);
		await expect(
			ops.run("discord_edit_thread", { threadId: "61", archived: true }),
		).rejects.toThrow("OWNER_PERMISSION_MISSING");
		expect(thread.edits).toEqual([]);

		const both = setup([ViewChannel, ManageThreads], [Administrator]);
		const shared = new FakeThread("62", both.guild, ChannelType.PublicThread);
		both.channels.set("62", shared);
		await both.ops.run("discord_edit_thread", {
			threadId: "62",
			archived: true,
		});
		expect(shared.edits).toMatchObject([{ archived: true }]);
	});

	test("private threads are listed only when the owner may manage threads", async () => {
		const list = async (ownerGrants: bigint[]) => {
			const { ops, guild } = setup(ownerGrants, [Administrator]);
			guild.threadList.set(
				"63",
				new FakeThread("63", guild, ChannelType.PublicThread, "open"),
			);
			guild.threadList.set(
				"64",
				new FakeThread("64", guild, ChannelType.PrivateThread, "secret"),
			);
			const threads = (await ops.run("discord_list_threads", {
				guildId: "1",
			})) as { name: string }[];
			return threads.map((t) => t.name);
		};
		expect(await list([ViewChannel])).toEqual(["open"]);
		expect(await list([ViewChannel, ManageThreads])).toEqual([
			"open",
			"secret",
		]);
	});
});
