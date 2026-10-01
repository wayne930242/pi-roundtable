import { expect, test } from "bun:test";
import { definePlugin, PluginError, Roundtable } from "pi-roundtable";
import { servicePair, silentLogger, testPlugin } from "pi-roundtable/testing";
import {
	NOTE_INDEX,
	type NoteIndex,
	noteReader,
	notes,
	shoutingNotes,
} from "./shared-services.ts";

/** Runs a host over the plugins, and stops it again. */
async function withHost(
	plugins: ConstructorParameters<typeof Roundtable>[1],
	inside: () => void,
) {
	const roundtable = new Roundtable({ logger: silentLogger() }, plugins);
	await roundtable.run();
	try {
		inside();
	} finally {
		await roundtable.shutdown("test");
	}
}

/** A plugin that writes a note, as any plugin after the notes may. */
const writer = definePlugin({
	name: "writer",
	setup: ({ services }) => {
		services.get(NOTE_INDEX).add("hi");
		return { services: [{ name: "writer" }] };
	},
});

test("a plugin reads what the plugin before it provided", async () => {
	const seen: (readonly string[] | undefined)[] = [];
	await withHost(
		[notes(), writer, noteReader((list) => seen.push(list))],
		() => {
			expect(seen).toEqual([["hi"]]);
		},
	);
});

test("a plugin under test gets the service it reads from the harness, and find is undefined without it", async () => {
	const seen: (readonly string[] | undefined)[] = [];
	const given: NoteIndex = { add: () => undefined, all: () => ["a", "b"] };
	const harness = await testPlugin(
		noteReader((list) => seen.push(list)),
		{ services: [servicePair(NOTE_INDEX, given)] },
	);
	const bare = await testPlugin(noteReader((list) => seen.push(list)));
	await harness.stop();
	await bare.stop();
	expect(seen).toEqual([["a", "b"], undefined]);
});

test("a replacement takes the place of the plugin that provided the key, and everyone after it reads the replacement", async () => {
	const seen: (readonly string[] | undefined)[] = [];
	await withHost(
		[notes(), shoutingNotes(), writer, noteReader((list) => seen.push(list))],
		() => expect(seen).toEqual([["HI"]]),
	);
});

test("a provider that does not provide what it lists is refused after setup", async () => {
	await expect(
		testPlugin({
			name: "forgetful",
			provides: [NOTE_INDEX],
			setup: () => ({ services: [{ name: "idle" }] }),
		}),
	).rejects.toBeInstanceOf(PluginError);
});
