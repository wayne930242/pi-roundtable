import { describe, expect, test } from "bun:test";
import { EventBus } from "./events.ts";
import { silentLogger } from "./log.ts";
import type { EventHandlers } from "./plugin.ts";

const turn = {
	agent: "infra",
	kind: "agent",
	channel: "discord:1" as const,
	speaker: undefined,
};

describe("EventBus", () => {
	test("delivers to every plugin's handler in registration order", async () => {
		const log: string[] = [];
		const bus = new EventBus(silentLogger());
		const handlers = (name: string): EventHandlers => ({
			turnStarted: (event) => {
				log.push(`${name} ${event.agent}`);
			},
		});
		bus.link([
			{ plugin: "a", events: handlers("a") },
			{ plugin: "b", events: handlers("b") },
		]);
		await bus.deliver("turnStarted", turn);
		expect(log).toEqual(["a infra", "b infra"]);
	});

	test("a handler that throws is logged with its plugin and never stops the others", async () => {
		const logged: { plugin: string; event: string }[] = [];
		const bus = new EventBus({
			...silentLogger(),
			error: (fields: unknown) => {
				logged.push(fields as { plugin: string; event: string });
			},
		});
		const reached: string[] = [];
		bus.link([
			{
				plugin: "bad",
				events: {
					changed: () => {
						throw new Error("boom");
					},
				},
			},
			{
				plugin: "good",
				events: {
					changed: () => {
						reached.push("good");
					},
				},
			},
		]);
		await bus.deliver("changed");
		expect(reached).toEqual(["good"]);
		expect(logged).toMatchObject([{ plugin: "bad", event: "changed" }]);
	});

	test("reports to the sink before the handlers are linked are dropped", async () => {
		const log: string[] = [];
		const bus = new EventBus(silentLogger());
		bus.sink.changed();
		bus.link([
			{
				plugin: "a",
				events: {
					changed: () => {
						log.push("changed");
					},
				},
			},
		]);
		await Bun.sleep(1);
		expect(log).toEqual([]);
		bus.sink.changed();
		await Bun.sleep(1);
		expect(log).toEqual(["changed"]);
	});

	test("an action reported to the sink reaches every handler, and a throwing one is logged", async () => {
		const logged: { plugin: string; event: string }[] = [];
		const bus = new EventBus({
			...silentLogger(),
			error: (fields: unknown) => {
				logged.push(fields as { plugin: string; event: string });
			},
		});
		const heard: string[] = [];
		bus.link([
			{
				plugin: "bad",
				events: {
					action: () => {
						throw new Error("boom");
					},
				},
			},
			{
				plugin: "good",
				events: {
					action: (event) => {
						heard.push(`${event.kind} ${event.actor} ${event.ok}`);
					},
				},
			},
		]);
		bus.sink.action?.({
			kind: "assign",
			actor: "discord:1",
			principalId: "p1",
			channel: "page:inbox",
			ok: true,
			at: new Date(0),
		});
		await Bun.sleep(1);
		expect(heard).toEqual(["assign discord:1 true"]);
		expect(logged).toMatchObject([{ plugin: "bad", event: "action" }]);
	});
});
