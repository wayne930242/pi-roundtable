import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AttachmentBuilder, MessageFlags } from "discord.js";
import { messages } from "../i18n/index.ts";
import type { Logger } from "../log.ts";

/** The most characters of one card's copy text; a longer one gets no copy button. */
export const COPY_TEXT_LIMIT = 20_000;
/** How many cards' copy texts are kept by default, the newest. */
const COPY_KEEP = 100;
/** How many days a copy text is kept by default. */
const COPY_KEEP_DAYS = 30;

interface Entry {
	text: string;
	at: number;
}

export interface CardCopiesOptions {
	/** A JSON file that keeps the texts across restarts; without it they live in memory only. */
	path?: string;
	/** How many cards' texts are kept, the newest; default `COPY_KEEP`. */
	keep?: number;
	/** How many days a text is kept; default `COPY_KEEP_DAYS`. */
	keepDays?: number;
	logger: Logger;
	/** Replaceable in tests. */
	now?: () => number;
}

/**
 * The text behind an approval card's copy button, by the card's id: the button's custom id holds
 * the id only, so the text is looked up when it is pressed, also after the process restarted when
 * there is a file. Bounded by count and age. The file is written off the hot path, one write at a
 * time and a burst of cards in one, through a temporary file that replaces it whole, readable by
 * the host's user only; one that cannot be read or written is logged and the texts that remain
 * are kept in memory. Discarding a conversation does not remove its cards' texts: they age out.
 */
export class CardCopies {
	readonly #options: CardCopiesOptions;
	readonly #entries = new Map<string, Entry>();
	#writing: Promise<void> | undefined;
	#dirty = false;

	constructor(options: CardCopiesOptions) {
		this.#options = options;
		const { path, logger } = options;
		if (!path || !existsSync(path)) return;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (typeof parsed !== "object" || parsed === null)
				throw new Error("not a JSON object");
			for (const [id, entry] of Object.entries(parsed)) {
				const { text, at } = entry as Partial<Entry>;
				if (typeof text === "string" && typeof at === "number")
					this.#entries.set(id, { text, at });
			}
			this.#prune();
		} catch (error) {
			logger.warn(
				{ path, err: error },
				"card copy texts not read; copy buttons of earlier cards will say they are gone",
			);
		}
	}

	/** Keeps a card's copy text. */
	remember(id: string, text: string): void {
		this.#entries.set(id, { text, at: this.#now() });
		this.#prune();
		this.#schedule();
	}

	/** A card's copy text; undefined when it was never kept or has aged out. */
	recall(id: string): string | undefined {
		const entry = this.#entries.get(id);
		if (!entry) return undefined;
		if (this.#now() - entry.at > this.#keepMs()) {
			this.#entries.delete(id);
			return undefined;
		}
		return entry.text;
	}

	/** Resolves once what was remembered so far is on disk; for a host that stops and for tests. */
	async flush(): Promise<void> {
		while (this.#writing) await this.#writing;
	}

	#now(): number {
		return (this.#options.now ?? Date.now)();
	}

	#keepMs(): number {
		return (this.#options.keepDays ?? COPY_KEEP_DAYS) * 24 * 60 * 60_000;
	}

	#prune(): void {
		const now = this.#now();
		const keep = this.#options.keep ?? COPY_KEEP;
		for (const [id, entry] of this.#entries)
			if (now - entry.at > this.#keepMs()) this.#entries.delete(id);
		for (const id of this.#entries.keys()) {
			if (this.#entries.size <= keep) return;
			this.#entries.delete(id);
		}
	}

	/** Writes the file after the call that asked, once at a time; asks made meanwhile share the next write. */
	#schedule(): void {
		if (!this.#options.path) return;
		this.#dirty = true;
		if (this.#writing) return;
		this.#writing = this.#drain().finally(() => {
			this.#writing = undefined;
		});
	}

	async #drain(): Promise<void> {
		// Let the caller finish before the entries are serialized.
		await Promise.resolve();
		while (this.#dirty) {
			this.#dirty = false;
			await this.#write();
		}
	}

	async #write(): Promise<void> {
		const { path, logger } = this.#options;
		if (!path) return;
		try {
			await mkdir(dirname(path), { recursive: true });
			const temporary = `${path}.tmp`;
			await writeFile(
				temporary,
				`${JSON.stringify(Object.fromEntries(this.#entries))}\n`,
				{ mode: 0o600 },
			);
			// A temporary file left by an earlier run keeps its mode, so set it.
			await chmod(temporary, 0o600);
			await rename(temporary, path);
		} catch (error) {
			logger.warn({ path, err: error }, "card copy texts not saved");
		}
	}
}

/** Discord's limit for the text of a message. */
const MESSAGE_LIMIT = 2_000;
/** A button label's limit. */
const LABEL_LIMIT = 80;

/**
 * The copy button an approval offers: its label and text; none when there is no text, and none,
 * reported through `tooLong`, when the text is over `COPY_TEXT_LIMIT`.
 */
export function offeredCopy(
	copy: { label?: string; text: string } | undefined,
	tooLong: (chars: number) => void,
): { label: string; text: string } | undefined {
	if (!copy || copy.text === "") return undefined;
	if (copy.text.length > COPY_TEXT_LIMIT) {
		tooLong(copy.text.length);
		return undefined;
	}
	const label = copy.label?.trim();
	return {
		label: label ? label.slice(0, LABEL_LIMIT) : messages().cardCopyLabel,
		text: copy.text,
	};
}

/** The reply to a press of a copy button: the text in a code block, or a file when it does not fit one. */
export function copyReply(text: string) {
	const block = `\`\`\`\n${text}\n\`\`\``;
	const inline = !text.includes("```") && block.length <= MESSAGE_LIMIT;
	return {
		content: inline ? block : messages().cardCopyFile,
		...(inline
			? {}
			: {
					files: [
						new AttachmentBuilder(Buffer.from(text, "utf8"), {
							name: "copy.txt",
						}),
					],
				}),
		flags: MessageFlags.Ephemeral as const,
		allowedMentions: { parse: [] as never[] },
	};
}
