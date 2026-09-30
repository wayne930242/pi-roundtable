import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "canvas";
import type { ImageDrawer } from "../contract/providers.ts";
import type { HttpRoute } from "../http/listeners.ts";

const AVATAR_SIDE = 512;
const REFERENCE_SIDE = 512;
const HASH_PATH = /^\/avatars\/([0-9a-f]{64})\.png$/;

export type { ImageDrawer };

export interface AvatarStudioOptions {
	/** Where pictures are kept, one `<sha256>.png` each. */
	dir: string;
	/** Origin the pictures are served from, such as https://assistant.example.com. */
	publicUrl: string;
	/** The assistant's neutral avatar: the style reference and the picture of an agent without one. */
	referencePath: string;
	draw: ImageDrawer;
}

/** A centered square crop scaled to at most `side` pixels, as PNG. */
async function squarePng(bytes: Uint8Array, side: number): Promise<Buffer> {
	const image = await loadImage(Buffer.from(bytes));
	const crop = Math.min(image.width, image.height);
	const size = Math.min(side, crop);
	const canvas = createCanvas(size, size);
	canvas
		.getContext("2d")
		.drawImage(
			image,
			(image.width - crop) / 2,
			(image.height - crop) / 2,
			crop,
			crop,
			0,
			0,
			size,
			size,
		);
	return canvas.toBuffer("image/png");
}

/**
 * Agent avatars: Codex draws them in the assistant's style, and they are kept and served by content
 * hash, so a new picture has a new URL and Discord shows it at once.
 */
export class AvatarStudio {
	readonly #options: AvatarStudioOptions;
	#defaultHash: string | undefined;

	constructor(options: AvatarStudioOptions) {
		this.#options = options;
		mkdirSync(options.dir, { recursive: true });
	}

	/** Stores the assistant's neutral avatar, the picture of an agent that has none yet. */
	async init(): Promise<void> {
		this.#defaultHash = await this.#store(
			readFileSync(this.#options.referencePath),
		);
	}

	/** The public URL of a picture, or of the default when there is none. */
	url(hash: string | undefined): string {
		const chosen = hash ?? this.#defaultHash;
		if (!chosen) throw new Error("the avatar studio was not initialized");
		return `${this.#options.publicUrl}/avatars/${chosen}.png`;
	}

	/**
	 * Draws a new picture from an avatar prompt: the assistant's face as an anime character in the
	 * role's pose; returns its hash. Outfit and background colours come from the avatar prompt,
	 * so agents stay easy to tell apart.
	 */
	async draw(avatarPrompt: string): Promise<string> {
		const reference = await squarePng(
			readFileSync(this.#options.referencePath),
			REFERENCE_SIDE,
		);
		const bytes = await this.#options.draw(
			`Draw a square Discord avatar of the person in the reference image, redrawn as an anime character: keep their face, short dark hair, and features recognizable as the same person, but in vivid anime cel-shading with a big, exaggerated expression and a dramatic pose that shows the role. Dress them and paint the background exactly in the colours the description names; ignore the reference's green jacket and teal background. Head-and-shoulders framing that still reads at 40 px. No text, no border. The role: ${avatarPrompt}`,
			[{ data: reference.toString("base64"), mimeType: "image/png" }],
		);
		return this.#store(bytes);
	}

	/** Edits a stored picture by an instruction; returns the new picture's hash. */
	async edit(hash: string | undefined, instruction: string): Promise<string> {
		const current = readFileSync(
			this.#path(hash ?? this.#defaultHashOrThrow()),
		);
		const bytes = await this.#options.draw(
			`Edit this Discord avatar: ${instruction}. Keep everything else, the style, and the square head-and-shoulders framing the same. No text, no border.`,
			[{ data: current.toString("base64"), mimeType: "image/png" }],
		);
		return this.#store(bytes);
	}

	/** Avatar pictures, public on the listener that cloudflared forwards the public hostname to. */
	route(listener: string): HttpRoute {
		return {
			name: "avatars",
			listener,
			path: { prefix: "/avatars/" },
			methods: ["GET", "HEAD"],
			handle: (request) =>
				// pi-lens-ignore: unchecked-throwing-call -- the server builds request.url, always an absolute URL
				this.serve(new URL(request.url).pathname) ??
				new Response("Not found", { status: 404 }),
		};
	}

	/** Serves `/avatars/<hash>.png`; undefined for any other path. */
	serve(pathname: string): Response | undefined {
		const match = HASH_PATH.exec(pathname);
		if (!match?.[1]) return undefined;
		const path = this.#path(match[1]);
		if (!existsSync(path)) return new Response("Not found", { status: 404 });
		return new Response(readFileSync(path), {
			headers: {
				"Content-Type": "image/png",
				"Cache-Control": "public, max-age=31536000, immutable",
			},
		});
	}

	#defaultHashOrThrow(): string {
		if (!this.#defaultHash)
			throw new Error("the avatar studio was not initialized");
		return this.#defaultHash;
	}

	#path(hash: string): string {
		return join(this.#options.dir, `${hash}.png`);
	}

	async #store(bytes: Uint8Array): Promise<string> {
		const png = await squarePng(bytes, AVATAR_SIDE);
		const hash = createHash("sha256").update(png).digest("hex");
		const path = this.#path(hash);
		if (!existsSync(path)) writeFileSync(path, png);
		return hash;
	}
}
