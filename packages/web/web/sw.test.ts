import { expect, test } from "bun:test";

type Listener = (event: unknown) => void;

interface Shown {
	title: string;
	options: Record<string, unknown>;
}

/** Loads the worker over a stand-in for its global scope and returns what it did. */
async function worker(windows: { url: string }[] = []) {
	const listeners = new Map<string, Listener>();
	const shown: Shown[] = [];
	const opened: string[] = [];
	const focused: string[] = [];
	const told: unknown[] = [];
	const scope = {
		registration: {
			scope: "https://app.example.test/console/",
			showNotification: async (
				title: string,
				options: Record<string, unknown>,
			) => void shown.push({ title, options }),
		},
		clients: {
			claim: async () => undefined,
			matchAll: async () =>
				windows.map((window) => ({
					url: window.url,
					focus: async () => void focused.push(window.url),
					postMessage: (message: unknown) => void told.push(message),
				})),
			openWindow: async (url: string) => void opened.push(url),
		},
		skipWaiting: async () => undefined,
		addEventListener: (type: string, listener: Listener) =>
			void listeners.set(type, listener),
	};
	// The worker reads its globals once, as it loads; they are put back so no other test sees them.
	const globals = globalThis as Record<string, unknown>;
	const before = ["self", "__PRECACHE__", "__VERSION__"].map(
		(name) => [name, name in globals, globals[name]] as const,
	);
	globals.self = scope;
	globals.__PRECACHE__ = [];
	globals.__VERSION__ = "test";
	try {
		await import(`./sw.ts?${Math.random()}`);
	} finally {
		for (const [name, had, value] of before)
			if (had) globals[name] = value;
			else delete globals[name];
	}
	const fire = async (type: string, event: object) => {
		const pending: Promise<unknown>[] = [];
		listeners.get(type)?.({
			...event,
			waitUntil: (work: Promise<unknown>) => void pending.push(work),
		});
		await Promise.all(pending);
	};
	return { fire, shown, opened, focused, told, listeners };
}

const push = (payload: unknown) => ({
	data: { json: () => payload },
});

test("a push shows its title, text and tag, and remembers where a tap goes", async () => {
	const sw = await worker();
	await sw.fire(
		"push",
		push({
			title: "Card waiting",
			body: "Send it?",
			tag: "app:agent.guide",
			url: "/console/#/room/app%3Aagent.guide",
		}),
	);
	expect(sw.shown).toHaveLength(1);
	expect(sw.shown[0]?.title).toBe("Card waiting");
	expect(sw.shown[0]?.options).toMatchObject({
		body: "Send it?",
		tag: "app:agent.guide",
		data: { url: "https://app.example.test/console/#/room/app%3Aagent.guide" },
	});
});

test("a push that cannot be read still shows a notification, and a link outside the app goes to the app", async () => {
	const sw = await worker();
	await sw.fire("push", {
		data: {
			json: () => {
				throw new Error("not json");
			},
		},
	});
	await sw.fire("push", { data: null });
	await sw.fire("push", push({ title: 7, url: "https://evil.example/phish" }));
	expect(sw.shown.map((one) => one.title)).toEqual([
		"Roundtable",
		"Roundtable",
		"Roundtable",
	]);
	expect(sw.shown[2]?.options.data).toEqual({
		url: "https://app.example.test/console/",
	});
});

test("a tap opens the room in the open window, or in a new one", async () => {
	const url = "https://app.example.test/console/#/room/x";
	const open = await worker([{ url: "https://app.example.test/console/" }]);
	const closed: string[] = [];
	await open.fire("notificationclick", {
		notification: { close: () => void closed.push("closed"), data: { url } },
	});
	expect(closed).toEqual(["closed"]);
	expect(open.focused).toEqual(["https://app.example.test/console/"]);
	expect(open.told).toEqual([{ type: "roundtable:open", url }]);
	expect(open.opened).toEqual([]);
	const none = await worker([]);
	await none.fire("notificationclick", {
		notification: { close: () => undefined, data: { url } },
	});
	expect(none.opened).toEqual([url]);
});

/** Runs one GET through the worker's fetch handler over stand-ins for the cache and the network. */
async function fetched(path: string) {
	const stored = new Map<string, Response>();
	const globals = globalThis as Record<string, unknown>;
	const before = ["caches", "fetch"].map(
		(name) => [name, name in globals, globals[name]] as const,
	);
	const cache = {
		match: async (request: Request) => stored.get(request.url),
		put: async (request: Request, response: Response) =>
			void stored.set(request.url, response),
	};
	globals.caches = { open: async () => cache };
	globals.fetch = async () => new Response("body");
	try {
		const sw = await worker();
		let answered: Promise<Response> | undefined;
		sw.listeners.get("fetch")?.({
			request: new Request(`https://app.example.test/console/${path}`),
			respondWith: (response: Promise<Response>) => {
				answered = response;
			},
		});
		await answered;
		return { answered: answered !== undefined, stored };
	} finally {
		for (const [name, had, value] of before)
			if (had) globals[name] = value;
			else delete globals[name];
	}
}

test("the round table's WebGL chunk is cached when it is first fetched, while the API still bypasses the worker", async () => {
	const chunk = await fetched("chunk-table3d-m7wew621.js");
	expect(chunk.answered).toBe(true);
	expect([...chunk.stored.keys()]).toEqual([
		"https://app.example.test/console/chunk-table3d-m7wew621.js",
	]);
	const api = await fetched("api/rooms");
	expect(api.answered).toBe(false);
	expect(api.stored.size).toBe(0);
	const other = await fetched("chunk-other-m7wew621.js");
	expect(other.answered).toBe(false);
});

test("the files pane's editor and language chunks are cached when they are first fetched, and a workspace file never is", async () => {
	for (const name of [
		"chunk-codeeditor-a1b2c3d4.js",
		"chunk-lang-python-a1b2c3d4.js",
	]) {
		const chunk = await fetched(name);
		expect(chunk.answered).toBe(true);
		expect([...chunk.stored.keys()]).toEqual([
			`https://app.example.test/console/${name}`,
		]);
	}
	for (const path of [
		"api/workspace",
		"api/workspace/agents/file?path=a.ts",
		"api/workspace/agents/raw?path=a.png",
		"api/workspace/agents/list?path=",
	]) {
		const file = await fetched(path);
		expect(file.answered).toBe(false);
		expect(file.stored.size).toBe(0);
	}
});
