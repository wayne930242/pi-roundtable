import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { AttachmentBuilder, MessageFlags } from "discord.js";
import { messages } from "../i18n/index.ts";
import type { Logger } from "../log.ts";

/** The most characters of one card's copy text; a longer one gets no copy button. */
export const COPY_TEXT_LIMIT = 100_000;
/** How many cards' copy texts are kept, the newest. */
const COPY_ENTRIES = 100;
/** How long a copy text is kept. */
const COPY_TTL_MS = 30 * 24 * 60 * 60_000;

interface Entry {
	text: string;
	at: number;
}

export interface CardCopiesOptions {
	/** A JSON file that keeps the texts across restarts; without it they live in memory only. */
	path?: string;
	logger: Logger;
	/** Replaceable in tests. */
	now?: () => number;
}

/**
 * The text behind an approval card's copy button, by the card's id: the button's custom id holds
 * the id only, so the text is looked up when it is pressed, also after the process restarted.
 * Bounded by count and age; a file that cannot be read or written is logged and the texts that
 * remain are kept in memory.
 */
export class CardCopies {
	readonly #options: CardCopiesOptions;
	readonly #entries = new Map<string, Entry>();

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
		this.#entries.set(id, { text, at: (this.#options.now ?? Date.now)() });
		this.#prune();
		this.#write();
	}

	/** A card's copy text; undefined when it was never kept or has aged out. */
	recall(id: string): string | undefined {
		const entry = this.#entries.get(id);
		if (!entry) return undefined;
		if ((this.#options.now ?? Date.now)() - entry.at > COPY_TTL_MS) {
			this.#entries.delete(id);
			return undefined;
		}
		return entry.text;
	}

	#prune(): void {
		const now = (this.#options.now ?? Date.now)();
		for (const [id, entry] of this.#entries)
			if (now - entry.at > COPY_TTL_MS) this.#entries.delete(id);
		for (const id of this.#entries.keys()) {
			if (this.#entries.size <= COPY_ENTRIES) return;
			this.#entries.delete(id);
		}
	}

	#write(): void {
		const { path, logger } = this.#options;
		if (!path) return;
		try {
			mkdirSync(dirname(path), { recursive: true });
			const temporary = `${path}.tmp`;
			writeFileSync(
				temporary,
				`${JSON.stringify(Object.fromEntries(this.#entries))}\n`,
				{ mode: 0o600 },
			);
			renameSync(temporary, path);
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
	return {
		label: (copy.label ?? messages().cardCopyLabel).slice(0, LABEL_LIMIT),
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
