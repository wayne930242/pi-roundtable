import type { IdentityService, Logger, Tier } from "pi-roundtable";
import type { NewOutboxRow, OutboxKind, PushOutbox } from "./outbox.ts";
import type { PushPrefsStore } from "./prefs.ts";
import { previewOf } from "./triggers.ts";

export interface PushDispatchOptions {
	outbox: Pick<PushOutbox, "enqueue">;
	prefs: Pick<PushPrefsStore, "quietAt">;
	identity: Pick<IdentityService, "tierOf" | "speakerFor">;
	/** The tiers whose people receive push. */
	tiers: readonly Tier[];
	/** `full` queues a title (and a preview with `preview`); `none` queues the kind, tag and count only. */
	content: "full" | "none";
	preview: boolean;
	/** Whether a page of the person is in view now. */
	visible(principalId: string): boolean;
	/** The operator's quiet window, which holds back a normal notice; absent = none. */
	quiet?: (at: number) => boolean;
	/** Starts the in-process sender at once; absent when a separate process drains the outbox. */
	kick?: () => void;
	/** Whether push is set up at all (a VAPID contact, or an external sender). */
	enabled: boolean;
	/** The transports the sender has, which a notice's `via` may name. */
	transports: readonly string[];
	logger: Logger;
	/** The clock, in milliseconds; default `Date.now`. */
	now?: () => number;
}

/** What a notice says when it is queued for a person. */
export interface NoticePush {
	tag: string;
	title: string;
	body?: string;
	/** The path a tap opens. */
	open: string;
	urgency: "normal" | "high";
	badge: number;
	via?: readonly string[];
}

/** Why a push was not queued; the notice itself is in the bell all the same. */
export type Withheld = "off" | "tier" | "visible" | "quiet" | "failed";

/**
 * Decides whether a notice becomes a push for a person and queues it. A person gets it only when
 * push is set up, their tier may receive it, and (for a normal notice) no page of theirs is in
 * view and it is not their quiet hours or the operator's; a `high` notice ignores the last two.
 * Whatever the content setting, the row carries a title and preview only with `content: "full"`.
 */
export class PushDispatch {
	readonly #options: PushDispatchOptions;

	constructor(options: PushDispatchOptions) {
		this.#options = options;
	}

	/** The transports the sender has; a notice's `via` must name only these. */
	get transports(): readonly string[] {
		return this.#options.transports;
	}

	async notice(
		principalId: string,
		notice: NoticePush,
	): Promise<"queued" | Withheld> {
		const { logger } = this.#options;
		try {
			if (!this.#options.enabled) return "off";
			if (!(await this.#mayReceive(principalId))) return "tier";
			if (notice.urgency === "normal") {
				if (this.#options.visible(principalId)) return "visible";
				const at = (this.#options.now ?? Date.now)();
				if (this.#options.quiet?.(at)) return "quiet";
				if (await this.#options.prefs.quietAt(principalId, at)) return "quiet";
			}
			await this.#queue(principalId, "notice", notice);
			return "queued";
		} catch (error) {
			logger.warn({ err: error, tag: notice.tag }, "a notice was not queued");
			return "failed";
		}
	}

	/** Tells the person's devices a notice is gone: closes its notification and sets the count. */
	async clear(
		principalId: string,
		tag: string,
		open: string,
		badge: number,
	): Promise<void> {
		try {
			if (!this.#options.enabled) return;
			await this.#queue(principalId, "clear", {
				tag,
				title: "",
				open,
				urgency: "normal",
				badge,
			});
		} catch (error) {
			this.#options.logger.warn(
				{ err: error, tag },
				"a notice was not cleared on the devices",
			);
		}
	}

	/** A test push to the person's own devices; it is not held back by quiet hours or an open page. */
	async test(principalId: string, tag: string, open: string, badge: number) {
		await this.#queue(principalId, "test", {
			tag,
			title: "Test notification",
			body: "Notifications work on this device.",
			open,
			urgency: "normal",
			badge,
		});
	}

	async #mayReceive(principalId: string): Promise<boolean> {
		const { identity, tiers } = this.#options;
		const lasting = await identity.tierOf(principalId);
		if (lasting) return tiers.includes(lasting);
		try {
			return tiers.includes((await identity.speakerFor(principalId)).tier);
		} catch {
			return false;
		}
	}

	async #queue(
		principalId: string,
		kind: OutboxKind,
		notice: NoticePush,
	): Promise<void> {
		const { content, preview, outbox, kick } = this.#options;
		const row: NewOutboxRow = {
			kind,
			tag: notice.tag,
			principalId,
			open: notice.open,
			urgency: notice.urgency,
			badge: notice.badge,
			...(content === "full" && kind !== "clear"
				? {
						title: notice.title,
						...(preview && notice.body ? { body: previewOf(notice.body) } : {}),
					}
				: {}),
			...(notice.via ? { via: notice.via } : {}),
		};
		await outbox.enqueue(row);
		kick?.();
	}
}
