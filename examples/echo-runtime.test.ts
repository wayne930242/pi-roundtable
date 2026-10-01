import { afterEach, expect, test } from "bun:test";
import {
	definePlugin,
	PluginError,
	Roundtable,
	type RoundtablePlugin,
} from "pi-roundtable";
import { OWNER_SPEAKER, silentLogger, testPlugin } from "pi-roundtable/testing";
import { createEchoRuntime, EchoRuntime, echoRuntime } from "./echo-runtime.ts";
import { FakeSurface } from "./fake-surface.ts";

/** One host runs per process, so each test stops its own. */
const hosts: Roundtable[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.shutdown("test");
});

function host(plugins: RoundtablePlugin[]): Roundtable {
	const roundtable = new Roundtable({ logger: silentLogger() }, plugins);
	hosts.push(roundtable);
	return roundtable;
}

test("the harness builds the runtime from the slot, the way the agent server does", async () => {
	const harness = await testPlugin(echoRuntime);
	expect(harness.runtime).toBeInstanceOf(EchoRuntime);
	await harness.stop();
});

test("a turn run through context.turns goes through the plugin's runtime, and the answer goes out through the surface", async () => {
	const surface = new FakeSurface();
	const harness = await testPlugin(echoRuntime, { surfaces: [surface] });
	const result = await harness.turns.run({
		channel: "fake:room",
		kind: "owner",
		text: "hello",
		speaker: OWNER_SPEAKER,
	});
	expect(result).toEqual({ ok: true, text: "[owner] hello" });
	expect(surface.replies).toEqual([
		{ channel: "fake:room", reply: { chunks: ["[owner] hello"] } },
	]);
	// The surface showed typing and the stop control while the turn ran.
	expect(surface.typing).toEqual(["start fake:room", "stop fake:room"]);
	expect(surface.stops).toEqual(["show fake:room", "hide fake:room"]);
	expect(harness.events.map(({ name }) => name)).toEqual([
		"turnStarted",
		"turnEnded",
	]);
	await harness.stop();
});

test("an agent's turn carries its scope, and its conversation is the scope's session", async () => {
	const harness = await testPlugin(echoRuntime);
	const { runtime } = harness;
	if (!runtime) throw new Error("the plugin fills the runtime slot");
	const result = await runtime.runTurn({
		channel: "fake:agent-room",
		selection: { id: "agent", tools: [], groups: [] },
		text: "status?",
		agent: {
			name: "infra",
			session: "fake:agent-room",
			home: "fake:agent-room",
		},
	});
	expect(result).toEqual({ ok: true, text: "[agent infra] status?" });
	expect(await runtime.recentTranscript("fake:agent-room", 10)).toEqual([
		{ role: "user", text: "status?" },
		{ role: "assistant", text: "[agent infra] status?" },
	]);
	await runtime.startFresh("fake:agent-room");
	expect(await runtime.recentTranscript("fake:agent-room", 10)).toEqual([]);
	await harness.stop();
});

test("a turn of a kind nobody wrote a persona for fails with the fix, and the surface says so", async () => {
	const surface = new FakeSurface();
	const harness = await testPlugin(echoRuntime, { surfaces: [surface] });
	const result = await harness.turns.run({
		channel: "fake:room",
		kind: "quiz",
		text: "hello",
		speaker: OWNER_SPEAKER,
	});
	expect(result.ok).toBe(false);
	expect(!result.ok && result.error.message).toContain("`personas`");
	expect(surface.replies).toHaveLength(1);
	await harness.stop();
});

test("the host resolves the slot to the plugin's factory", async () => {
	let filled = false;
	const probe = definePlugin({
		name: "probe",
		setup: ({ providers }) => {
			filled = providers.filled.has("runtime");
			expect(providers.runtime).toBe(createEchoRuntime);
			return { services: [{ name: "probe" }] };
		},
	});
	await host([echoRuntime, probe]).run();
	expect(filled).toBe(true);
});

test("only one plugin may fill the runtime slot", async () => {
	const another = definePlugin({
		name: "another-runtime",
		providers: { runtime: createEchoRuntime },
		setup: () => ({}),
	});
	const error = await host([echoRuntime, another])
		.run()
		.then(
			() => undefined,
			(failure: unknown) => failure,
		);
	expect(error).toBeInstanceOf(PluginError);
	expect(String(error)).toContain(
		"provider slot runtime is already filled by plugin echo-runtime",
	);
});
