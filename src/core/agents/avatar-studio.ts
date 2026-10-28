import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { squarePng } from "../attachments/square-png.ts";
import type { ImageDrawer } from "../contract/providers.ts";
import { ProviderError } from "../errors.ts";
import type { HttpRoute } from "../http/listeners.ts";
import type { AvatarStudio } from "../services.ts";
import { fallbackAvatar } from "./fallback-avatar.ts";

const AVATAR_SIDE = 512;
const REFERENCE_SIDE = 512;
/** The configured reference is the host's own photo, so only the decoded-pixel budget limits it. */
const REFERENCE_MAX_SIDE = Number.MAX_SAFE_INTEGER;
const HASH_PATH = /^\/avatars\/([0-9a-f]{64})\.png$/;

export type { ImageDrawer };

export interface AvatarStudioOptions {
	/** Where pictures are kept, one `<sha256>.png` each. */
	dir: string;
	/**
	 * Origin the pictures are served from, such as https://assistant.example.com. Without one a
	 * picture's URL is the path `/avatars/<hash>.png`, which a surface that serves the pictures
	 * itself, through `serve`, resolves against its own origin.
	 */
	publicUrl?: string;
	/** The assistant's neutral avatar: the style reference and the picture of an agent without one. */
	referencePath: string;
	/** The neutral avatar shipped with the package; the reference is replaced by it when the reference cannot be read as a picture. */
	neutralPath?: string;
	/** Told the error code of a reference that was replaced by `neutralPath`. */
	onReferenceFailed?: (code: string) => void;
	/** Draws the pictures. Without one, the studio only makes each agent a picture from its name. */
	draw?: ImageDrawer;
}

/**
 * Agent avatars: an image provider draws them in the assistant's style, and without one each agent
 * gets a picture generated from its display name. They are kept and served by content hash, so a
 * new picture has a new URL and Discord shows it at once.
 */
export class FileAvatarStudio implements AvatarStudio {
	readonly #options: AvatarStudioOptions;
	#defaultHash: string | undefined;
	#referencePath: string;

	constructor(options: AvatarStudioOptions) {
		this.#options = options;
		this.#referencePath = options.referencePath;
		mkdirSync(options.dir, { recursive: true });
	}

	/** Stores the assistant's neutral avatar, the picture of an agent that has none yet. */
	async init(): Promise<void> {
		try {
			this.#defaultHash = await this.#referenceStore();
		} catch (error) {
			const { neutralPath, onReferenceFailed } = this.#options;
			if (!neutralPath || neutralPath === this.#referencePath) throw error;
			const code =
				(error as { code?: unknown }).code ??
				(error as { reason?: unknown }).reason ??
				(error as Error).name;
			onReferenceFailed?.(
				/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(String(code))
					? String(code)
					: "error",
			);
			this.#referencePath = neutralPath;
			this.#defaultHash = await this.#referenceStore();
		}
	}

	async #referenceStore(): Promise<string> {
		return this.#store(readFileSync(this.#referencePath), REFERENCE_MAX_SIDE);
	}

	/** Whether an image provider is configured; without one, only `fallback` makes pictures. */
	get canDraw(): boolean {
		return this.#options.draw !== undefined;
	}

	/** The public URL of a picture, or of the default when there is none. */
	url(hash: string | undefined): string {
		const chosen = hash ?? this.#defaultHash;
		if (!chosen) throw new Error("the avatar studio was not initialized");
		return `${this.#options.publicUrl ?? ""}/avatars/${chosen}.png`;
	}

	/**
	 * Draws a new picture from an avatar prompt: the assistant's face as an anime character in the
	 * role's pose; returns its hash. Outfit and background colours come from the avatar prompt,
	 * so agents stay easy to tell apart.
	 */
	async draw(avatarPrompt: string): Promise<string> {
		const draw = this.#drawer();
		const reference = await squarePng(readFileSync(this.#referencePath), {
			size: REFERENCE_SIDE,
			maxSide: REFERENCE_MAX_SIDE,
		});
		const bytes = await draw(
			`Draw a square Discord avatar of the person in the reference image, redrawn as an anime character: keep their face, short dark hair, and features recognizable as the same person, but in vivid anime cel-shading with a big, exaggerated expression and a dramatic pose that shows the role. Dress them and paint the background exactly in the colours the description names; ignore the reference's green jacket and teal background. Head-and-shoulders framing that still reads at 40 px. No text, no border. The role: ${avatarPrompt}`,
			[{ data: reference.toString("base64"), mimeType: "image/png" }],
		);
		return this.#store(bytes);
	}

	/** Edits a stored picture by an instruction; returns the new picture's hash. */
	async edit(hash: string | undefined, instruction: string): Promise<string> {
		const draw = this.#drawer();
		const current = readFileSync(
			this.#path(hash ?? this.#defaultHashOrThrow()),
		);
		const bytes = await draw(
			`Edit this Discord avatar: ${instruction}. Keep everything else, the style, and the square head-and-shoulders framing the same. No text, no border.`,
			[{ data: current.toString("base64"), mimeType: "image/png" }],
		);
		return this.#store(bytes);
	}

	/**
	 * A picture made from an agent's display name, its name, and the assistant's icon, for a host without an
	 * image provider; the same name always gives the same picture. Returns its hash.
	 */
	async fallback(displayName: string, name: string): Promise<string> {
		return this.#store(
			await fallbackAvatar(
				displayName,
				readFileSync(this.#referencePath),
				name,
			),
		);
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

	#drawer(): ImageDrawer {
		if (!this.#options.draw)
			throw new ProviderError(
				"no image provider is configured, so avatars cannot be drawn",
			);
		return this.#options.draw;
	}

	#defaultHashOrThrow(): string {
		if (!this.#defaultHash)
			throw new Error("the avatar studio was not initialized");
		return this.#defaultHash;
	}

	#path(hash: string): string {
		return join(this.#options.dir, `${hash}.png`);
	}

	async #store(bytes: Uint8Array, maxSide?: number): Promise<string> {
		const png = await squarePng(bytes, {
			size: AVATAR_SIDE,
			...(maxSide === undefined ? {} : { maxSide }),
		});
		const hash = createHash("sha256").update(png).digest("hex");
		const path = this.#path(hash);
		if (!existsSync(path)) writeFileSync(path, png);
		return hash;
	}
}
