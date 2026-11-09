import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplyFileError } from "pi-roundtable";
import { testPlugin } from "pi-roundtable/testing";
import { drawing } from "./plugin.ts";
import { seededRandom } from "./random.ts";
import { pngSize, RecordingSurface } from "./testing/fake-surface.ts";
import { filesOf, MAP, open } from "./testing/plugin-fixture.ts";
import { writeTestDecks } from "./testing/test-deck.ts";

let deckDir = "";

beforeAll(() => {
	deckDir = writeTestDecks();
});

afterAll(() => rmSync(deckDir, { recursive: true, force: true }));

describe("tools", () => {
	test("without a deck directory the plugin offers the four drawing tools", async () => {
		const { harness } = await open();
		expect(harness.tools).toEqual([
			"relationship_map",
			"magic_circle_generate",
			"sigil_generate",
			"sacred_geometry_generate",
		]);
		for (const name of harness.tools)
			expect(harness.tiers.minTier(name)).toBe("member");
		await harness.stop();
	});

	test("a deck directory adds draw_cards, and minTier sets every tool's tier", async () => {
		const { harness } = await open({ deckDir, minTier: "admin" });
		expect(harness.tools).toContain("draw_cards");
		for (const name of harness.tools)
			expect(harness.tiers.minTier(name)).toBe("admin");
		await harness.stop();
	});
});

describe("images", () => {
	test("relationship_map attaches a PNG to the reply of the turn and sends nothing itself", async () => {
		const { harness, surface } = await open({ random: seededRandom(1) });
		const text = await harness.runTool("relationship_map", MAP, {
			channel: "test:42",
		});
		expect(text).toBe(
			"The relationship map is attached to your reply as relationship-map.png.",
		);
		expect(harness.files).toHaveLength(1);
		expect(harness.files[0]?.channel).toBe("test:42");
		const [file] = filesOf(harness);
		expect(file?.name).toBe("relationship-map.png");
		const size = pngSize(file?.data ?? new Uint8Array());
		expect(size).toBeDefined();
		// The picture is as big as its content, with a floor of 400 by 300.
		expect(size?.width).toBeGreaterThanOrEqual(400);
		expect(size?.height).toBeGreaterThanOrEqual(300);
		// The agent's reply carries the file; the tool does not post on its own.
		expect(surface.replies).toHaveLength(0);
		await harness.stop();
	});

	test("the same seed draws the same map and another seed draws another", async () => {
		const draw = async (seed: number) => {
			const { harness } = await open({ random: seededRandom(seed) });
			await harness.runTool("relationship_map", MAP);
			await harness.stop();
			return Buffer.from(filesOf(harness)[0]?.data ?? []);
		};
		const [a, b, c] = [await draw(5), await draw(5), await draw(6)];
		expect(a.length).toBeGreaterThan(1000);
		expect(a.equals(b)).toBe(true);
		expect(a.equals(c)).toBe(false);
	});

	test("a map takes names in any script", async () => {
		const { harness } = await open({ random: seededRandom(2) });
		await harness.runTool("relationship_map", {
			nodes: [
				{ id: "\u963f\u8c6a", type: "pc" },
				{ id: "\u5c0f\u7f8e", type: "npc" },
			],
			edges: [{ from: "\u963f\u8c6a", to: "\u5c0f\u7f8e", type: "bond" }],
		});
		expect(
			pngSize(filesOf(harness)[0]?.data ?? new Uint8Array()),
		).toBeDefined();
		await harness.stop();
	});

	test.each([
		["small", 512],
		["medium", 1024],
		["large", 2048],
	])("magic_circle_generate draws a %s circle of %d px", async (size, px) => {
		const { harness } = await open();
		const text = await harness.runTool("magic_circle_generate", {
			type: "pentagram",
			size,
			elements: ["fire", "air", "water", "earth"],
			text: "Ad astra",
		});
		expect(text).toBe(
			"The magic circle is attached to your reply as magic-circle.png.",
		);
		expect(pngSize(filesOf(harness)[0]?.data ?? new Uint8Array())).toEqual({
			width: px,
			height: px,
		});
		await harness.stop();
	});

	test("every circle type, background, and style draws, and drawing is deterministic", async () => {
		const { harness } = await open();
		for (const type of ["pentagram", "hexagram", "tree_of_life", "custom"])
			for (const background of ["dark", "white", "transparent"])
				await harness.runTool("magic_circle_generate", {
					type,
					background,
					style: "modern",
					size: "small",
				});
		expect(filesOf(harness)).toHaveLength(12);
		for (const file of filesOf(harness))
			expect(pngSize(file.data)).toEqual({ width: 512, height: 512 });
		await harness.runTool("magic_circle_generate", { type: "hexagram" });
		await harness.runTool("magic_circle_generate", { type: "hexagram" });
		const [a, b] = filesOf(harness).slice(-2);
		expect(Buffer.from(a?.data ?? []).equals(Buffer.from(b?.data ?? []))).toBe(
			true,
		);
		await harness.stop();
	});

	test.each(["chaos", "rose_cross", "planetary", "geometric"])(
		"sigil_generate draws by the %s method",
		async (method) => {
			const { harness } = await open();
			const text = await harness.runTool("sigil_generate", {
				intention: "find the way home",
				method,
			});
			expect(text).toBe("The sigil is attached to your reply as sigil.png.");
			expect(pngSize(filesOf(harness)[0]?.data ?? new Uint8Array())).toEqual({
				width: 512,
				height: 512,
			});
			await harness.stop();
		},
	);

	test.each(["flower_of_life", "metatron", "sri_yantra", "vesica_pisces"])(
		"sacred_geometry_generate draws the %s pattern",
		async (pattern) => {
			const { harness } = await open();
			const text = await harness.runTool("sacred_geometry_generate", {
				pattern,
				layers: 4,
				rotation: 15,
				colors: ["gold", "#5fc4b8"],
			});
			expect(text).toBe(
				"The sacred geometry is attached to your reply as sacred-geometry.png.",
			);
			expect(pngSize(filesOf(harness)[0]?.data ?? new Uint8Array())).toEqual({
				width: 1024,
				height: 1024,
			});
			await harness.stop();
		},
	);
});

describe("refusals", () => {
	const refused = async (
		tool: string,
		args: Record<string, unknown>,
		expected: string | RegExp,
	) => {
		const { harness, surface } = await open();
		const text = await harness.runTool(tool, args);
		expect(text).toMatch(expected);
		// A refused call attaches nothing.
		expect(surface.replies).toHaveLength(0);
		expect(harness.files).toHaveLength(0);
		await harness.stop();
	};

	test("a map with no nodes", () =>
		refused("relationship_map", { nodes: [], edges: [] }, /nodes/));

	test("an edge to a node that is not there", () =>
		refused(
			"relationship_map",
			{
				nodes: [{ id: "Ada", type: "pc" }],
				edges: [{ from: "Ada", to: "Ghost", type: "bond" }],
			},
			'An edge references the unknown node "Ghost". Add it to nodes or fix the edge.',
		));

	test("two nodes with one id", () =>
		refused(
			"relationship_map",
			{
				nodes: [
					{ id: "Ada", type: "pc" },
					{ id: "Ada", type: "npc" },
				],
				edges: [],
			},
			'Two nodes share the id "Ada". Node ids must be unique.',
		));

	test("an edge from a node to itself", () =>
		refused(
			"relationship_map",
			{
				nodes: [{ id: "Ada", type: "pc" }],
				edges: [{ from: "Ada", to: "Ada", type: "bond" }],
			},
			/to itself/,
		));

	test("a node type that does not exist is caught by the schema", () =>
		refused(
			"relationship_map",
			{ nodes: [{ id: "Ada", type: "dragon" }], edges: [] },
			/The arguments are not valid/,
		));

	test("more nodes than the limit", () =>
		refused(
			"relationship_map",
			{
				nodes: Array.from({ length: 41 }, (_, i) => ({
					id: `n${i}`,
					type: "npc",
				})),
				edges: [],
			},
			/The arguments are not valid/,
		));

	test("rim text over the limit", () =>
		refused(
			"magic_circle_generate",
			{ type: "pentagram", text: "x".repeat(61) },
			/The arguments are not valid/,
		));

	test("an unknown element", () =>
		refused(
			"magic_circle_generate",
			{ type: "pentagram", elements: ["aether"] },
			/The arguments are not valid/,
		));

	test("a sigil of an intention with no letters", () =>
		refused(
			"sigil_generate",
			{ intention: "1234 !!", method: "chaos" },
			"The chaos method draws from letters, and the intention has none. Write it in words, or use the geometric method.",
		));

	test("an empty sigil intention", () =>
		refused(
			"sigil_generate",
			{ intention: "", method: "geometric" },
			/The arguments are not valid/,
		));

	test("a color canvas cannot read", () =>
		refused(
			"sacred_geometry_generate",
			{ pattern: "flower_of_life", colors: ["not-a-color"] },
			'"not-a-color" is not a CSS color. Use a name such as gold or a code such as #c0a060.',
		));

	test("layers out of range", () =>
		refused(
			"sacred_geometry_generate",
			{ pattern: "metatron", layers: 12 },
			/The arguments are not valid/,
		));

	test("a channel no surface serves fails the call", async () => {
		const { harness } = await open();
		await expect(
			harness.runTool(
				"sigil_generate",
				{ intention: "home", method: "chaos" },
				{
					channel: "nowhere:1",
				},
			),
		).rejects.toBeInstanceOf(ReplyFileError);
		expect(harness.files).toHaveLength(0);
		await harness.stop();
	});

	test("with a scratch dir the picture is attached and also saved there, and the result names the path", async () => {
		const root = mkdtempSync(join(tmpdir(), "drawing-save-"));
		const scratchDir = join(root, "scratch");
		const workspace = join(root, "work");
		const { harness } = await open({ random: seededRandom(1) });
		const text = await harness.runTool(
			"sigil_generate",
			{ intention: "home", method: "chaos" },
			{ workspace: { workspace, scratchDir } },
		);
		expect(harness.files).toHaveLength(1);
		const saved = readdirSync(join(scratchDir, "drawings"));
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatch(/^sigil_generate-.+\.png$/);
		const path = join(scratchDir, "drawings", saved[0] as string);
		expect(text).toContain(path);
		expect(text).toMatch(/discord_send_message or attach_file/);
		expect(
			Buffer.from(readFileSync(path)).equals(
				Buffer.from(harness.files[0]?.file.data ?? []),
			),
		).toBe(true);
		expect(existsSync(join(workspace, "drawings"))).toBe(false);
		await harness.stop();
		rmSync(root, { recursive: true, force: true });
	});

	test("without a scratch dir the picture is saved in the workspace", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "drawing-save-"));
		const { harness } = await open({ random: seededRandom(1) });
		const text = await harness.runTool("relationship_map", MAP, {
			workspace: { workspace },
		});
		const saved = readdirSync(join(workspace, "drawings"));
		expect(saved).toHaveLength(1);
		expect(text).toContain(join(workspace, "drawings", saved[0] as string));
		await harness.stop();
		rmSync(workspace, { recursive: true, force: true });
	});

	test("a surface that cannot carry files fails the call instead of dropping the picture", async () => {
		const surface = new RecordingSurface();
		const harness = await testPlugin(drawing(), {
			surfaces: [Object.assign(surface, { supportsFiles: false })],
		});
		await expect(
			harness.runTool("sigil_generate", { intention: "home", method: "chaos" }),
		).rejects.toThrow(/does not support reply files/);
		expect(harness.files).toHaveLength(0);
		expect(surface.replies).toHaveLength(0);
		await harness.stop();
	});
});
