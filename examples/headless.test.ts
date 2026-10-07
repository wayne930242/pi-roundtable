import { afterEach, expect, test } from "bun:test";
import {
	AGENTS,
	defineRoundtable,
	type PluginContext,
	Roundtable,
	RUNTIME,
} from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";
import {
	describeDb,
	silentLogger,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import { echoRuntime } from "./echo-runtime.ts";
import { FakeSurface } from "./fake-surface.ts";
import { studyHall } from "./headless.ts";

let roundtable: Roundtable | undefined;
afterEach(async () => {
	await roundtable?.shutdown("test");
	roundtable = undefined;
});

async function until(done: () => boolean): Promise<void> {
	for (let waited = 0; !done() && waited < 2000; waited += 5)
		await Bun.sleep(5);
	expect(done()).toBe(true);
}

describeDb("a host without Discord", () => {
	test("boots without Discord or the agent server and answers a study room through its runtime", async () => {
		const surface = new FakeSurface();
		const config = studyHall(surface, {
			databaseUrl: testDatabaseUrl,
			dataDir: `${Bun.env.TMPDIR ?? "/tmp"}/study-hall-${crypto.randomUUID()}`,
		});
		let context: PluginContext | undefined;
		const { options, plugins } = await defineRoundtable(
			{
				...config,
				plugins: [
					...(config.plugins ?? []),
					// The echo runtime stands in for Pi, so the test calls no model.
					echoRuntime,
					{
						name: "probe",
						setup: (given) => {
							context = given;
							return { services: [{ name: "probe" }] };
						},
					},
				],
			},
			{ logger: silentLogger() },
		);
		const names = plugins.map((plugin) => plugin.name);
		expect(names).not.toContain("discord");
		expect(names).not.toContain("agent-server");
		expect(options.listeners).toEqual([]);
		roundtable = new Roundtable(options, plugins);
		await roundtable.run();
		expect(context?.services.find(DISCORD)).toBeUndefined();
		expect(context?.services.find(AGENTS)).toBeUndefined();
		expect(context?.services.get(RUNTIME)).toBeDefined();
		surface.say("fake:study-algebra", "What is a group?");
		await until(() => surface.replies.length > 0);
		expect(surface.replies[0]?.reply.chunks.join()).toContain(
			"What is a group?",
		);
	});
});
