import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONVERSATIONS,
	type ConversationRegistry,
	IDENTITY,
	type IdentityService,
	Roundtable,
	type RoundtablePlugin,
} from "pi-roundtable";
import { DISCORD, type DiscordServices } from "pi-roundtable/discord";
import {
	describeDb,
	fakeDiscord,
	partial,
	silentLogger,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import { remoteMcp } from "./remote-mcp-plugin.ts";

// The principal the dispatch token stands for is read in the plugin's preflight, which the host
// runs before any service starts, so a token linked to no one stops the start before a surface
// connects. Runs only when ROUNDTABLE_TEST_DATABASE_URL is set (the plugin has migrations).

const dirs: string[] = [];
const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.shutdown("test");
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function plugins(
	principalOf: IdentityService["principalOf"],
	started: string[],
): RoundtablePlugin[] {
	const discord = fakeDiscord();
	const services: RoundtablePlugin = {
		name: "stand-ins",
		provides: [DISCORD, IDENTITY, CONVERSATIONS],
		setup: ({ services }) => {
			// SAFETY: remote-mcp reads the commands registrar and guard in setup, and the rest when a request arrives.
			services.provide(DISCORD, discord.service.given as DiscordServices);
			services.provide(
				IDENTITY,
				partial<IdentityService>({
					principalOf,
					tierOf: async () => undefined,
					owners: async () => [],
				}),
			);
			services.provide(
				CONVERSATIONS,
				partial<ConversationRegistry>({ adopt: async () => undefined }),
			);
			return { services: [{ name: "stand-ins" }] };
		},
	};
	// Registered before remote-mcp, so its service would start before any of the plugin's.
	const surface: RoundtablePlugin = {
		name: "surface-probe",
		setup: () => ({
			services: [
				{
					name: "surface-probe",
					start: () => {
						started.push("surface-probe");
					},
				},
			],
		}),
	};
	return [
		services,
		surface,
		remoteMcp({
			dispatchToken: "dispatch-token-for-tests",
			publicUrl: "https://bot.example.test",
			answer: async () => ({ ok: true, text: "" }),
			claim: {
				startFresh: async () => "remote",
				deleteConversation: async () => undefined,
			},
		}),
	];
}

function host(list: RoundtablePlugin[]): Roundtable {
	const dir = mkdtempSync(join(tmpdir(), "roundtable-mcp-preflight-"));
	dirs.push(dir);
	const roundtable = new Roundtable(
		{
			logger: silentLogger(),
			database: { url: testDatabaseUrl },
			listeners: [{ id: "public", socketPath: join(dir, "public.sock") }],
		},
		list,
	);
	hosts.push(roundtable);
	return roundtable;
}

describeDb("remote-mcp's preflight on a host", () => {
	test("a token linked to no one stops the start before any service starts", async () => {
		const started: string[] = [];
		await expect(
			host(plugins(async () => undefined, started)).run(),
		).rejects.toThrow(
			"remote-mcp: token:remote-mcp, the dispatch token's identity, is linked to no principal",
		);
		expect(started).toEqual([]);
	});

	test("a linked token lets the services start after the principal was read", async () => {
		const started: string[] = [];
		await host(plugins(async () => "owner", started)).run();
		expect(started).toEqual(["surface-probe"]);
	});
});
