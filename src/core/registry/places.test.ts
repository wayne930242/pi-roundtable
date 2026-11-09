import { expect, test } from "bun:test";
import type { PlacePort } from "../contract/places.ts";
import type { ChatSurface } from "../contract/surface.ts";
import { NotLinkedError, PluginError } from "../kernel/errors.ts";
import { silentLogger } from "../kernel/log.ts";
import type { PluginContext, RoundtablePlugin } from "../plugin-api/plugin.ts";
import { surfacePort } from "../routing/surface-port.ts";
import { toolTiers } from "../runtime/tool-tiers.ts";
import { FakePager } from "../testing/fake-pager-places.ts";
import { FakeRoomSurface } from "../testing/fake-room-surface.ts";
import { collectContributions } from "./contributions.ts";

/** A surface that serves channels but no agent rooms. */
const plain = (surface: string): ChatSurface => ({
	surface,
	start: async () => undefined,
	sendReply: async () => undefined,
});

/** The registry's view of the plugins, with the surface port the host would hand every plugin. */
const collect = (plugins: RoundtablePlugin[]) =>
	collectContributions(
		plugins,
		{
			logger: silentLogger(),
			env: { agentTools: "full" },
			surfaces: surfacePort(() => []),
		} as unknown as PluginContext,
		toolTiers(),
	);

test("the context's places are read once every plugin is set up: stored providers first, then a derived one for each room surface", async () => {
	let seen: PlacePort | undefined;
	let early: unknown;
	const pager = new FakePager().provider;
	const registry = await collect([
		{
			name: "app",
			setup: (context) => {
				seen = context.places;
				try {
					context.places.all();
				} catch (error) {
					early = error;
				}
				return { surfaces: [new FakeRoomSurface("app")] };
			},
		},
		{
			name: "pager",
			setup: () => ({
				surfaces: [plain("pager")],
				places: [pager],
			}),
		},
	]);
	expect(early).toBeInstanceOf(NotLinkedError);
	expect(registry.places).toEqual([pager]);
	expect(seen?.all().map((p) => `${p.surface}:${p.storage}`)).toEqual([
		"pager:stored",
		"app:derived",
	]);
	expect(seen?.of("pager:pg-1")).toBe(pager);
});

test("a provider needs a surface name, a storage and the three members every provider has", async () => {
	const bad = (provider: object) =>
		collect([
			{
				name: "p",
				setup: () => ({
					surfaces: [plain("pager")],
					places: [provider as never],
				}),
			},
		]);
	const pager = new FakePager().provider;
	await expect(bad({ ...pager, surface: "a:b" })).rejects.toThrow(PluginError);
	await expect(bad({ ...pager, storage: "kept" })).rejects.toThrow(
		'needs storage "derived" or "stored"',
	);
	await expect(bad({ ...pager, post: undefined })).rejects.toThrow(
		"needs post()",
	);
});
