import type { AttachmentRetention } from "../attachments/attachment-retention.ts";
import { integer, optional, shape } from "./schema.ts";

/** The configuration's `attachments`: what the host does with the files people send. */
export interface AttachmentsConfig {
	/**
	 * Removes the files turns used once they are `maxAgeMs` old (counted from the turn that took
	 * the file), giving the owners' used-bytes allowance back; sweeps when the host starts and every
	 * `sweepEveryMs` (default one hour, at most `maxAgeMs`). Left out, used files live as long as
	 * their conversation. Files waiting for a turn are not touched; the plugin that took them
	 * discards those.
	 */
	retention?: AttachmentRetention;
}

const YEAR_MS = 365 * 24 * 60 * 60_000;

/** The `attachments` key's shape. */
export const attachmentsShape = optional(
	shape({
		retention: optional(
			shape({
				maxAgeMs: integer(1, YEAR_MS),
				sweepEveryMs: optional(integer(1, YEAR_MS)),
			}),
		),
	}),
);
