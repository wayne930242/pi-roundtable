import { describe, expect, test } from "bun:test";
import {
	type CharacterSpec,
	resolveCharacter,
} from "../../characters/index.ts";
import { silentLogger } from "../log.ts";
import type { Agent } from "./agent-store.ts";
import { refreshAvatars } from "./avatar-refresh.ts";
import { TeamLifecycle } from "./team-lifecycle.ts";
import type { TeamContext } from "./team-options.ts";

const wizard = resolveCharacter({ class: "wizard" });
const knight = resolveCharacter({ class: "knight" });
const hashOf = (spec: CharacterSpec, skins = "a") =>
	`${skins}:${JSON.stringify(spec).length}:${spec.class}`;

function agent(name: string, extra: Partial<Agent> = {}): Agent {
	return {
		name,
		displayName: name,
		prompt: "p",
		avatarPrompt: "",
		status: "active",
		...extra,
	};
}

/** A store of agents that records each picture it is told to set. */
function fakeStore(agents: Agent[]) {
	const set: [string, string][] = [];
	return {
		set,
		change: async (name: string, change: Partial<Agent>) => {
			Object.assign(agents.find((a) => a.name === name) ?? {}, change);
		},
		// Copies, as the real store hands out a new object when an agent changes.
		agents: () => agents.map((a) => ({ ...a })),
		agent: (name: string) => {
			const found = agents.find((a) => a.name === name);
			return found && { ...found };
		},
		// Compare-and-set, as the real store does inside its write queue.
		setAvatar: async (
			name: string,
			character: CharacterSpec,
			avatarHash: string,
		) => {
			const found = agents.find((a) => a.name === name);
			if (
				found?.status !== "active" ||
				JSON.stringify(found.character) !== JSON.stringify(character)
			)
				return false;
			set.push([name, avatarHash]);
			found.avatarHash = avatarHash;
			return true;
		},
	};
}

describe("refreshAvatars", () => {
	test("sets the changed pictures, skips the unchanged, and leaves agents without a character alone", async () => {
		const store = fakeStore([
			agent("old", { character: wizard, avatarHash: "stale" }),
			agent("same", { character: knight, avatarHash: hashOf(knight) }),
			agent("bare"),
			agent("gone", {
				character: wizard,
				avatarHash: "stale",
				status: "archived",
			}),
		]);
		const rendered: string[] = [];
		const result = await refreshAvatars({
			agents: store.agents,
			setAvatar: store.setAvatar,
			render: async (spec) => {
				rendered.push(spec.class);
				return hashOf(spec);
			},
			logger: silentLogger(),
		});
		expect(result).toEqual({
			rendered: 1,
			unchanged: 1,
			skipped: 0,
			failed: 0,
		});
		expect(store.set).toEqual([["old", hashOf(wizard)]]);
		expect(rendered).toEqual(["wizard", "knight"]);
	});

	test("one agent's failure is counted and the others still render", async () => {
		const store = fakeStore([
			agent("a", { character: wizard, avatarHash: "stale" }),
			agent("b", { character: knight, avatarHash: "stale" }),
			agent("c", { character: wizard, avatarHash: "stale" }),
		]);
		const warnings: unknown[][] = [];
		const logger = silentLogger();
		logger.warn = ((...args: unknown[]) => {
			warnings.push(args);
		}) as typeof logger.warn;
		const result = await refreshAvatars({
			agents: store.agents,
			render: async (spec) => {
				if (spec.class === "knight") throw new Error("no librsvg");
				return hashOf(spec);
			},
			setAvatar: async (name, character, hash) => {
				if (name === "c") throw new Error("database down");
				return store.setAvatar(name, character, hash);
			},
			logger,
		});
		expect(result).toEqual({
			rendered: 1,
			unchanged: 0,
			skipped: 0,
			failed: 2,
		});
		expect(store.set.map(([name]) => name)).toEqual(["a"]);
		expect(warnings).toHaveLength(1);
		const [fields, message] = warnings[0] as [{ reasons: string[] }, string];
		expect(message).toBe(
			"avatars refreshed: re-rendered 1, unchanged 0, skipped 0, failed 2",
		);
		expect(fields.reasons).toEqual(["b: no librsvg", "c: database down"]);
	});

	test("an agent whose look changed while it rendered keeps the newer picture", async () => {
		const store = fakeStore([
			agent("a", { character: wizard, avatarHash: "stale" }),
		]);
		const result = await refreshAvatars({
			agents: store.agents,
			setAvatar: store.setAvatar,
			render: async (spec) => {
				await store.change("a", {
					character: knight,
					avatarHash: hashOf(knight),
				});
				return hashOf(spec);
			},
			logger: silentLogger(),
		});
		expect(result).toEqual({
			rendered: 0,
			unchanged: 0,
			skipped: 1,
			failed: 0,
		});
		expect(store.set).toEqual([]);
	});
});

describe("refreshAvatars races", () => {
	test("a write queued behind a pending dress write does not put the old look's picture on the new look", async () => {
		const agents = [agent("a", { character: wizard, avatarHash: "stale" })];
		const store = fakeStore(agents);
		let release: () => void = () => {};
		const queue = new Promise<void>((resolve) => {
			release = resolve;
		});
		// The store's write queue: the dress write lands before the refresh's queued write runs.
		const pendingDress = queue.then(() => {
			const worn = agents[0] as Agent;
			worn.character = knight;
			worn.avatarHash = hashOf(knight);
		});
		const result = refreshAvatars({
			agents: store.agents,
			render: async (spec) => hashOf(spec),
			setAvatar: async (name, character, hash) => {
				await pendingDress;
				return store.setAvatar(name, character, hash);
			},
			logger: silentLogger(),
		});
		release();
		expect(await result).toEqual({
			rendered: 0,
			unchanged: 0,
			skipped: 1,
			failed: 0,
		});
		expect(agents[0]?.avatarHash).toBe(hashOf(knight));
	});

	test("an archived agent is skipped, not counted unchanged", async () => {
		const store = fakeStore([
			agent("a", { character: wizard, avatarHash: "stale" }),
		]);
		const result = await refreshAvatars({
			agents: store.agents,
			render: async (spec) => {
				await store.change("a", { status: "archived" });
				return hashOf(spec);
			},
			setAvatar: store.setAvatar,
			logger: silentLogger(),
		});
		expect(result.skipped).toBe(1);
		expect(store.set).toEqual([]);
	});

	test("after the signal aborts nothing is rendered, written or logged", async () => {
		const store = fakeStore([
			agent("a", { character: wizard, avatarHash: "stale" }),
			agent("b", { character: knight, avatarHash: "stale" }),
		]);
		const controller = new AbortController();
		const logs: unknown[] = [];
		const logger = silentLogger();
		logger.info = ((...args: unknown[]) => {
			logs.push(args);
		}) as typeof logger.info;
		logger.warn = logger.info;
		const rendered: string[] = [];
		const result = await refreshAvatars({
			agents: store.agents,
			render: async (spec) => {
				rendered.push(spec.class);
				controller.abort();
				return hashOf(spec);
			},
			setAvatar: store.setAvatar,
			signal: controller.signal,
			logger,
		});
		expect(rendered).toEqual(["wizard"]);
		expect(store.set).toEqual([]);
		expect(logs).toEqual([]);
		expect(result.rendered).toBe(0);
	});
});

/** A team start over fake parts: no Discord channels, every agent already dressed. */
async function startTeam(refreshAvatars: boolean | undefined) {
	const store = fakeStore([
		agent("old", { character: wizard, avatarHash: "stale" }),
		agent("same", { character: knight, avatarHash: hashOf(knight) }),
	]);
	let renders = 0;
	let changes = 0;
	const context = {
		options: {
			store: {
				...store,
				seed: async () => [],
				hasStoredCharacter: () => true,
				setAvatarIfLook: store.setAvatar,
			},
			studio: {
				render: async (spec: CharacterSpec) => {
					renders++;
					return hashOf(spec);
				},
			},
			seeds: () => [],
			logger: silentLogger(),
			...(refreshAvatars === undefined ? {} : { refreshAvatars }),
		},
		changed: () => {
			changes++;
		},
	} as unknown as TeamContext;
	await new TeamLifecycle(context).start();
	// The refresh runs after start returns; wait for it to settle.
	for (let i = 0; i < 50 && renders < (refreshAvatars ? 2 : 1); i++)
		await Bun.sleep(5);
	await Bun.sleep(20);
	return { store, renders, changes };
}

describe("team start with refreshAvatars", () => {
	test("off by default: nothing is rendered or set", async () => {
		for (const option of [undefined, false]) {
			const { store, renders } = await startTeam(option);
			expect(renders).toBe(0);
			expect(store.set).toEqual([]);
		}
	});

	test("on: the changed agent is set after start, the unchanged one skipped", async () => {
		const { store, renders, changes } = await startTeam(true);
		expect(renders).toBe(2);
		expect(store.set).toEqual([["old", hashOf(wizard)]]);
		expect(changes).toBeGreaterThanOrEqual(2);
	});
});
