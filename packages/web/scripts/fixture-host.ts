// A local host for trying the console in a browser, with no Discord and no database.
//
// It sets the plugin up on pi-roundtable's test harness over fixture conversations and an in-memory
// memory, then serves its routes on two ports:
//   PORT      stands in for the proxy that authenticates the owner: it signs a test Access token and adds
//             it to every request, so the built-in Cloudflare Access verifier runs for real;
//   PORT + 1  is the same listener reached directly, with no assertion, which the console must refuse.
// `/fixture/message` appends a message to the owner's conversation and `/fixture/work` toggles the
// agent between working and idle, so the live updates can be watched.
import { appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, IDENTITY, MEMORY } from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";
import { partial, servicePair, testPlugin } from "pi-roundtable/testing";
import { cloudflareAccess } from "../src/cloudflare-access.ts";
import {
	AGENT_CHANNEL,
	AUDIENCE,
	accessIdentity,
	accessKeys,
	fakeIdentity,
	fakeMemory,
	fixtureSessions,
	GROUP_CHANNEL,
	OWNER_CHANNEL,
	OWNER_EMAIL,
	OWNER_SUB,
	TEAM,
} from "../src/testing/fixtures.ts";
import { webConsole } from "../src/web-plugin.ts";

const port = Number(process.env.PORT ?? 4173);
const origin = `http://localhost:${port}`;
const dataDir = fixtureSessions();
const { keys, sign } = await accessKeys();

const listeners: (() => void)[] = [];
let working = false;
const today = new Date().toISOString().slice(0, 10);
/** Each principal's notes, kept across requests as the store keeps them. */
const memories = new Map<string, ReturnType<typeof fakeMemory>>();
function memoryOf(id: string) {
	const found =
		memories.get(id) ??
		fakeMemory(
			id === "owner"
				? [
						{ kind: "core", fact: "Prefers short answers.", eventDate: null },
						{
							kind: "note",
							fact: "The office wifi is on the guest network.",
							eventDate: null,
						},
						{ kind: "event", fact: "Dentist", eventDate: "2026-01-15" },
						{
							kind: "event",
							fact: "Conference",
							eventDate: `${today.slice(0, 4)}-12-31`,
						},
					]
				: [
						{
							kind: "core",
							fact: "Reads the morning report.",
							eventDate: null,
						},
					],
		);
	memories.set(id, found);
	return found;
}

const harness = await testPlugin(
	webConsole({
		verifier: cloudflareAccess({
			teamDomain: TEAM,
			audience: AUDIENCE,
			email: OWNER_EMAIL,
			keys,
		}),
		origin,
		dataDir,
		title: "Fixture console",
	}),
	{
		env: { timeZone: "Europe/Paris" },
		services: [
			servicePair(AGENTS, {
				team: partial({
					guildId: "900000000000000099",
					onChange: (listener: () => void) => listeners.push(listener),
					owns: (key: string) =>
						key === `discord:${AGENT_CHANNEL}`
							? "agent"
							: key === `discord:${GROUP_CHANNEL}`
								? "group"
								: undefined,
					status: async () => ({
						agents: [
							{
								name: "scout",
								displayName: "Scout",
								channelId: AGENT_CHANNEL,
								model: "provider/model",
								thinking: "auto",
								...(working ? { workingIn: OWNER_CHANNEL } : {}),
								waiting: working ? 1 : 0,
								context: { tokens: 42_000, contextWindow: 200_000 },
								lastActive: new Date(),
								schedules: 2,
							},
						],
						groups: [
							{
								name: "crew",
								displayName: "Crew",
								channelId: GROUP_CHANNEL,
								members: ["Scout", "Archivist"],
								host: "Scout",
								busy: 0,
							},
						],
					}),
				}) as never,
			}),
			// Two owners, so the notes pane offers the second one's notes too.
			servicePair(
				IDENTITY,
				fakeIdentity([
					{
						id: "owner",
						name: "Owner",
						tier: "owner",
						identities: [accessIdentity(OWNER_SUB)],
					},
					{ id: "p_fixture_second", name: "Second owner", tier: "owner" },
				]),
			),
			servicePair(MEMORY, {
				forSpeaker: (id: string) => memoryOf(id),
			}),

			servicePair(DISCORD, {
				connection: partial({
					channelInfo: async (id: string) =>
						id === OWNER_CHANNEL
							? {
									kind: "guild",
									name: "general",
									guild: "Home",
									guildId: "900000000000000099",
								}
							: id === AGENT_CHANNEL
								? {
										kind: "guild",
										name: "scout",
										guild: "Home",
										guildId: "900000000000000099",
									}
								: undefined,
				}) as never,
			}),
		],
	},
);

const routes = harness.contribution.http ?? [];
const routeFor = (path: string) =>
	routes.find((route) =>
		"exact" in route.path
			? route.path.exact === path
			: path.startsWith(route.path.prefix),
	);

function notify() {
	for (const listener of listeners) listener();
}

function appendMessage(role: string, text: string) {
	const dir = join(dataDir, "sessions", `discord_${OWNER_CHANNEL}`);
	const file = readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.at(-1);
	if (!file) throw new Error("no live file");
	appendFileSync(
		join(dir, file),
		`${JSON.stringify({
			type: "message",
			id: `live-${Date.now()}`,
			timestamp: new Date().toISOString(),
			message: { role, content: [{ type: "text", text }] },
		})}\n`,
	);
}

function serve(listenPort: number, signed: boolean) {
	return Bun.serve({
		port: listenPort,
		hostname: "localhost",
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/fixture/message") {
				appendMessage("user", `Live message at ${new Date().toISOString()}`);
				appendMessage("assistant", "Received.");
				notify();
				return new Response("ok");
			}
			if (url.pathname === "/fixture/work") {
				working = !working;
				notify();
				return new Response(working ? "working" : "idle");
			}
			const route = routeFor(url.pathname);
			if (!route) return new Response("Not found", { status: 404 });
			const headers = new Headers(request.headers);
			if (signed) headers.set("cf-access-jwt-assertion", await sign());
			return route.handle(new Request(request, { headers }));
		},
	});
}

const proxied = serve(port, true);
const direct = serve(port + 1, false);
console.log(
	JSON.stringify({
		console: `${origin}/console/`,
		direct: `http://localhost:${port + 1}/console/`,
		dataDir,
		pid: process.pid,
	}),
);
process.on("SIGTERM", async () => {
	await harness.stop();
	proxied.stop(true);
	direct.stop(true);
	process.exit(0);
});
