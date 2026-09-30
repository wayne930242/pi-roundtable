import { describe, expect, test } from "bun:test";
import { PluginError } from "./errors.ts";
import { CoreRegistry, type CoreStores } from "./services.ts";

const stores = {} as CoreStores;

describe("CoreRegistry", () => {
	test("gives a plugin what a built-in one provided", () => {
		const core = new CoreRegistry();
		core.provide("stores", stores);
		expect(core.stores).toBe(stores);
	});

	test("reading a service before it is provided names the service and the fix", () => {
		expect(() => new CoreRegistry().stores).toThrow(PluginError);
		expect(() => new CoreRegistry().stores).toThrow(
			"core service stores is not provided yet. Register the built-in plugin that provides it before the plugin that reads it.",
		);
	});

	test("a service provided twice is refused", () => {
		const core = new CoreRegistry();
		core.provide("stores", stores);
		expect(() => core.provide("stores", stores)).toThrow(
			"core service stores is provided twice. Register only one plugin that provides it.",
		);
	});
});
