import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "canvas";
import { ProviderError } from "../errors.ts";
import { FileAvatarStudio, type ImageDrawer } from "./avatar-studio.ts";

const REFERENCE = join(import.meta.dir, "..", "assets", "neutral.png");

function picture(width: number, height: number, color: string): Uint8Array {
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, width, height);
	return canvas.toBuffer("image/png");
}

async function studio(draw?: ImageDrawer) {
	const s = new FileAvatarStudio({
		dir: mkdtempSync(join(tmpdir(), "roundtable-avatars-")),
		publicUrl: "https://example.com",
		referencePath: REFERENCE,
		...(draw ? { draw } : {}),
	});
	await s.init();
	return s;
}

describe("FileAvatarStudio", () => {
	test("an agent without a picture gets the assistant's neutral avatar", async () => {
		const s = await studio(async () => picture(10, 10, "red"));
		const url = s.url(undefined);
		expect(url).toMatch(/^https:\/\/example\.com\/avatars\/[0-9a-f]{64}\.png$/);
		const served = s.serve(new URL(url).pathname);
		expect(served?.status).toBe(200);
		expect(served?.headers.get("Content-Type")).toBe("image/png");
	});

	test("draws with the reference and stores a square of at most 512 px", async () => {
		const prompts: string[] = [];
		const s = await studio(async (prompt, refs) => {
			prompts.push(prompt);
			expect(refs).toHaveLength(1);
			return picture(1024, 768, "blue");
		});
		const hash = await s.draw("a friendly engineer");
		expect(prompts[0]).toContain("a friendly engineer");
		expect(prompts[0]).toContain("anime");
		const served = s.serve(`/avatars/${hash}.png`);
		if (!served) throw new Error("not served");
		const image = await loadImage(Buffer.from(await served.arrayBuffer()));
		expect([image.width, image.height]).toEqual([512, 512]);
	});

	test("an edit starts from the current picture and yields a new hash", async () => {
		let references = 0;
		const s = await studio(async (_prompt, refs) => {
			references += refs.length;
			return picture(64, 64, references > 1 ? "green" : "blue");
		});
		const first = await s.draw("x");
		const second = await s.edit(first, "add glasses");
		expect(second).not.toBe(first);
	});

	test("serves nothing but avatar pictures", async () => {
		const s = await studio(async () => picture(4, 4, "red"));
		expect(s.serve("/mcp/personal")).toBeUndefined();
		expect(s.serve("/avatars/../secrets.env")).toBeUndefined();
		expect(s.serve(`/avatars/${"0".repeat(64)}.png`)?.status).toBe(404);
	});

	test("its public route answers GET for pictures and 404 for any other avatar path", async () => {
		const s = await studio(async () => picture(4, 4, "red"));
		const hash = await s.draw("x");
		const route = s.route("public");
		expect(route).toMatchObject({
			listener: "public",
			path: { prefix: "/avatars/" },
			methods: ["GET", "HEAD"],
		});
		const get = (path: string) =>
			route.handle(new Request(`https://example.com${path}`));
		expect((await get(`/avatars/${hash}.png`)).status).toBe(200);
		const other = await get("/avatars/../secrets.env");
		expect([other.status, await other.text()]).toEqual([404, "Not found"]);
	});

	test("with a provider it can draw", async () => {
		expect((await studio(async () => picture(4, 4, "red"))).canDraw).toBe(true);
	});

	describe("without an image provider", () => {
		test("cannot draw or edit, and says why", async () => {
			const s = await studio();
			expect(s.canDraw).toBe(false);
			await expect(s.draw("a fox")).rejects.toBeInstanceOf(ProviderError);
			await expect(s.edit(undefined, "add a hat")).rejects.toThrow(
				"no image provider is configured",
			);
		});

		test("makes a stable 512 px picture from a display name, served by its hash", async () => {
			const s = await studio();
			const hash = await s.fallback("Researcher", "researcher");
			expect(await s.fallback("Researcher", "researcher")).toBe(hash);
			expect(await s.fallback("\u738b\u5c0f\u660e", "xiao-ming")).not.toBe(
				hash,
			);
			expect(s.url(hash)).not.toBe(s.url(undefined));
			const served = s.serve(`/avatars/${hash}.png`);
			if (!served) throw new Error("not served");
			expect(served.status).toBe(200);
			const image = await loadImage(Buffer.from(await served.arrayBuffer()));
			expect([image.width, image.height]).toEqual([512, 512]);
			expect(s.url(hash)).toBe(`https://example.com/avatars/${hash}.png`);
		});
	});
});
