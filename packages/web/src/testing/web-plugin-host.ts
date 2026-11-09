import { afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, IDENTITY, MEMORY } from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";
import {
	partial,
	servicePair,
	type TestPluginResult,
	testPlugin,
} from "pi-roundtable/testing";
import { cloudflareAccess } from "../cloudflare-access.ts";
import { webConsole } from "../web-plugin.ts";
import {
	AUDIENCE,
	accessIdentity,
	accessKeys,
	type FakePrincipal,
	fakeIdentity,
	fakeMemory,
	fixtureSessions,
	ORIGIN,
	OWNER_EMAIL,
	OWNER_SUB,
	TEAM,
} from "./fixtures.ts";

export const { keys, sign } = await accessKeys();
export const verifier = cloudflareAccess({
	teamDomain: TEAM,
	audience: AUDIENCE,
	email: OWNER_EMAIL,
	keys,
});

/** A built page stand-in: the plugin reads whatever is in the directory. */
export function assetDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "web-console-page-"));
	writeFileSync(join(dir, "index.html"), "<html>console</html>");
	return dir;
}

export const harnesses: TestPluginResult[] = [];
/** Stops the plugin harnesses and clears the memories each test made. */
export function webPluginHostPerTest(): void {
	afterEach(async () => {
		await Promise.all(harnesses.splice(0).map((harness) => harness.stop()));
	});
	afterEach(() => memories.clear());
}

export const teamChanges: (() => void)[] = [];
export const agents = servicePair(AGENTS, {
	team: partial({
		discordGuild: "900000000000000099",
		onChange: (listener: () => void) => teamChanges.push(listener),
		owns: () => undefined,
		status: async () => ({ agents: [], groups: [] }),
	}) as never,
});
/** The owner, as the configuration links their Access identity, and their memory. */
export const OWNER: FakePrincipal = {
	id: "owner",
	name: "Owner",
	tier: "owner",
	identities: [accessIdentity(OWNER_SUB)],
};
export const SECOND_EMAIL = "second@example.test";
export const SECOND: FakePrincipal = {
	id: "p_01J0000000000000000000BEA0",
	name: "Bea",
	tier: "owner",
	identities: [accessIdentity("bea")],
};
export const MEMBER_EMAIL = "member@example.test";
export const MEMBER: FakePrincipal = {
	id: "p_01J0000000000000000000MEL0",
	name: "Mel",
	tier: "member",
	identities: [accessIdentity("mel")],
};
export const identity = (people: FakePrincipal[] = [OWNER]) =>
	servicePair(IDENTITY, fakeIdentity(people));
/** Each principal's memory, kept like the store keeps it: the same rows on every read. */
export const memories = new Map<string, ReturnType<typeof fakeMemory>>();
export const memory = servicePair(MEMORY, {
	forSpeaker: (id: string) => {
		const found =
			memories.get(id) ??
			fakeMemory([
				{
					kind: "core",
					fact: id === OWNER.id ? "Likes tea" : `Notes of ${id}`,
					eventDate: null,
				},
			]);
		memories.set(id, found);
		return found;
	},
});
export const discord = servicePair(DISCORD, {
	connection: partial({
		channelInfo: async () => ({ kind: "dm" as const, name: "Owner" }),
	}) as never,
});

/** The panes of 0.22: the owner app (`rooms`) needs a database and the agent server, which a plugin harness does not have. */
export const PANES = ["overview", "conversations", "notes"] as const;
export const base = () => ({
	verifier,
	origin: ORIGIN,
	ownerId: "owner",
	dataDir: fixtureSessions(),
	assetDir: assetDir(),
	panes: PANES,
});

export async function boot(
	options: Partial<Parameters<typeof webConsole>[0]> = {},
	people?: FakePrincipal[],
) {
	const harness = await testPlugin(webConsole({ ...base(), ...options }), {
		services: [agents, memory, discord, identity(people)],
	});
	harnesses.push(harness);
	const route = (name: string) => {
		const found = harness.contribution.http?.find((r) => r.name === name);
		if (!found) throw new Error(`no route ${name}`);
		return found;
	};
	const call = async (path: string, init: RequestInit = {}, jwt?: string) =>
		route("web-console").handle(
			new Request(`http://host${path}`, {
				...init,
				headers: {
					...(jwt ? { "cf-access-jwt-assertion": jwt } : {}),
					...init.headers,
				},
			}),
		);
	return { harness, call, route };
}
