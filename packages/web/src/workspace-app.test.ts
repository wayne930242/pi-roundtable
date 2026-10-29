import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActorFacts, AGENTS } from "pi-roundtable";
import { describeDb, type TestHost, testHost } from "pi-roundtable/testing";
import type {
	ConfigView,
	WorkspaceFileView,
	WorkspaceRootsView,
} from "./api-types.ts";
import { admitAs, refuse, type Verdict } from "./verifier.ts";
import { webConsole } from "./web-plugin.ts";

// This suite needs the test database (PG), like the other tests that boot the host with `rooms`.

const ORIGIN = "https://app.example.test";
const ADA_DISCORD = "100000000000000041";
const MEL_DISCORD = "200000000000000042";
const GUILD = "900000000000000741";
const ENTRY_CHANNEL = "900000000000000742";
const ADA: ActorFacts = {
	provider: "discord",
	subject: ADA_DISCORD,
	name: "Ada",
};
const MEL: ActorFacts = {
	provider: "discord",
	subject: MEL_DISCORD,
	name: "Mel",
};

function verifier(request: Request): Verdict {
	const who = request.headers.get("x-actor");
	if (who === "owner") return admitAs(ADA);
	if (who === "member") return admitAs(MEL);
	return refuse("no proxy assertion");
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

interface Booted {
	host: TestHost;
	socket: string;
	dataDir: string;
	work: string;
	scratch: string;
	stop(): Promise<void>;
}

async function boot(
	workspace: Parameters<typeof webConsole>[0]["workspace"],
): Promise<Booted> {
	const dataDir = mkdtempSync(join(tmpdir(), "workspace-app-"));
	const socket = join(dataDir, "public.sock");
	const assets = mkdtempSync(join(tmpdir(), "workspace-app-page-"));
	writeFileSync(join(assets, "index.html"), "<html>app</html>");
	const work = join(dataDir, "work");
	const scratch = join(dataDir, "scratch");
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, "notes.md"), "# notes\n");
	const host = await testHost({
		config: {
			dataDir,
			workDir: work,
			scratchDir: scratch,
			discord: { token: "token", guild: GUILD, entryChannel: ENTRY_CHANNEL },
			http: { publicUrl: "https://bot.example.com", socketPath: socket },
			access: {
				owners: [
					{
						name: "Ada",
						principal: ADA_DISCORD,
						identities: [`discord:${ADA_DISCORD}`],
					},
				],
				members: { identities: [`discord:${MEL_DISCORD}`] },
			},
			agents: [
				{
					name: "guide",
					displayName: "Guide",
					prompt: "You guide.",
					avatarPrompt: "A guide",
					channelId: ENTRY_CHANNEL,
				},
			],
		},
		runtime: {
			runTurn: async () => ({ ok: true as const, text: "" }),
			steer: async () => false,
			stop: () => false,
			startFresh: async () => undefined,
			deleteConversation: async () => undefined,
			pendingConfirmation: () => undefined,
			heldActions: async () => undefined,
			recentTranscript: async () => [],
		},
		plugins: [
			webConsole({
				verifier,
				origin: ORIGIN,
				dataDir,
				assetDir: assets,
				...(workspace ? { workspace } : {}),
			}),
		],
	});
	return {
		host,
		socket,
		dataDir,
		work,
		scratch,
		stop: async () => {
			await host.stop();
			rmSync(dataDir, { recursive: true, force: true });
		},
	};
}

function call(
	app: Booted,
	path: string,
	init: RequestInit & { who?: string; origin?: string | null } = {},
): Promise<Response> {
	const { who = "owner", origin = ORIGIN, ...rest } = init;
	return fetch(`http://localhost/console/api/${path}`, {
		...rest,
		headers: {
			"x-actor": who,
			...(origin ? { origin } : {}),
			...(rest.body ? { "content-type": "application/json" } : {}),
		},
		unix: app.socket,
	} as never);
}

describeDb("the files pane over a real host", () => {
	let app: Booted;
	beforeAll(async () => {
		app = await boot(undefined);
	}, 30_000);
	afterAll(async () => {
		await app.stop();
	});

	test("the agent server provides the agents' directories, and they are the pane's places", async () => {
		const workspace = app.host.context.services.get(AGENTS).workspace;
		expect(workspace.workDir).toBe(app.work);
		expect(workspace.scratchDir).toBe(app.scratch);
		const config = (await (await call(app, "config")).json()) as ConfigView;
		expect(config.panes).toContain("workspace");
		const roots = (await (
			await call(app, "workspace")
		).json()) as WorkspaceRootsView;
		expect(roots.roots.map((root) => [root.id, root.writable])).toEqual([
			["agents", true],
			["scratch", true],
		]);
	});

	test("an owner reads and saves an agent's file, and the member is refused everything", async () => {
		const view = (await (
			await call(app, "workspace/agents/file?path=notes.md")
		).json()) as WorkspaceFileView;
		expect(view).toMatchObject({
			text: "# notes\n",
			editable: true,
			language: "markdown",
		});
		const saved = await call(app, "workspace/agents/file?path=notes.md", {
			method: "PUT",
			body: JSON.stringify({ text: "# notes\nmore\n", baseHash: view.hash }),
		});
		expect(saved.status).toBe(200);
		expect(readFileSync(join(app.work, "notes.md"), "utf8")).toBe(
			"# notes\nmore\n",
		);
		const stale = await call(app, "workspace/agents/file?path=notes.md", {
			method: "PUT",
			body: JSON.stringify({ text: "x", baseHash: sha("# notes\n") }),
		});
		expect(stale.status).toBe(409);
		for (const [method, path] of [
			["GET", "workspace"],
			["GET", "workspace/agents/file?path=notes.md"],
			["PUT", "workspace/agents/file?path=notes.md"],
		] as const) {
			const refused = await call(app, path, {
				method,
				who: "member",
				...(method === "PUT"
					? { body: JSON.stringify({ text: "x", baseHash: sha("") }) }
					: {}),
			});
			expect([method, path, refused.status]).toEqual([method, path, 403]);
		}
		expect(readFileSync(join(app.work, "notes.md"), "utf8")).toBe(
			"# notes\nmore\n",
		);
	});

	test("a write from another origin is refused before it reaches the files", async () => {
		const response = await call(app, "workspace/agents/file?path=notes.md", {
			method: "PUT",
			origin: "https://evil.example",
			body: JSON.stringify({ text: "pwned", baseHash: sha("# notes\nmore\n") }),
		});
		expect(response.status).toBe(403);
		expect(readFileSync(join(app.work, "notes.md"), "utf8")).toBe(
			"# notes\nmore\n",
		);
		expect(existsSync(join(app.work, "pwned"))).toBe(false);
	});
});

describeDb("the files pane without a place to show", () => {
	let app: Booted;
	beforeAll(async () => {
		app = await boot({ agents: false, scratch: false });
	}, 30_000);
	afterAll(async () => {
		await app.stop();
	});

	test("is left out of the served panes, and its API answers 404", async () => {
		const config = (await (await call(app, "config")).json()) as ConfigView;
		expect(config.panes).not.toContain("workspace");
		expect((await call(app, "workspace")).status).toBe(404);
	});
});
