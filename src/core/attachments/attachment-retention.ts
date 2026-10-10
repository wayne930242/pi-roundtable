import type { AttachmentPort } from "../contract/attachments.ts";
import { PluginError } from "../errors.ts";
import type { Logger } from "../log.ts";
import type { Service } from "../plugin.ts";

/** How long used files are kept, and how often the host looks for the ones past it. */
export interface AttachmentRetention {
	/** Files a turn used more than this many milliseconds ago are removed. */
	maxAgeMs: number;
	/** The wait between two sweeps; default one hour, and never more than `maxAgeMs`. */
	sweepEveryMs?: number;
}

/** The wait between two sweeps when the host sets none. */
export const DEFAULT_SWEEP_EVERY_MS = 60 * 60_000;

/** The port's `expireUsed`; `retentionServices` refuses a port without it before a sweep can run. */
function expireUsedOf(
	attachments: AttachmentPort,
): NonNullable<AttachmentPort["expireUsed"]> {
	const expire = attachments.expireUsed;
	if (expire === undefined)
		throw new PluginError("this attachment port cannot expire used files");
	return expire.bind(attachments);
}

/** The wait between two sweeps for `retention`. */
function sweepPeriod(retention: AttachmentRetention): number {
	return Math.min(
		retention.sweepEveryMs ?? DEFAULT_SWEEP_EVERY_MS,
		retention.maxAgeMs,
	);
}

/**
 * The service that removes used attachments past their retention period: one sweep when the host
 * starts, then one every period, never two at once. A sweep that fails is logged by its error
 * code alone, since a file system error names the file, and the next sweep tries again. The logs
 * carry counts, never a file's name.
 */
export function retentionService(
	attachments: AttachmentPort,
	retention: AttachmentRetention,
	logger: Logger,
): Service {
	let timer: ReturnType<typeof setInterval> | undefined;
	let sweeping: Promise<void> | undefined;
	const sweep = async (): Promise<void> => {
		try {
			const result = await expireUsedOf(attachments)({
				olderThanMs: retention.maxAgeMs,
			});
			if (result.files > 0)
				logger.info(
					{
						files: result.files,
						bytes: result.bytes,
						unattributedBytes: result.unattributedBytes,
					},
					"used attachments past their retention period removed",
				);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			logger.warn(
				code === undefined ? {} : { code },
				"used attachments past their retention period not removed",
			);
		}
	};
	const once = (): Promise<void> => {
		sweeping ??= sweep().finally(() => {
			sweeping = undefined;
		});
		return sweeping;
	};
	return {
		name: "attachment-retention",
		start: async () => {
			await once();
			timer = setInterval(() => void once(), sweepPeriod(retention));
		},
		stop: async () => {
			clearInterval(timer);
			timer = undefined;
			await sweeping;
		},
	};
}

/**
 * The retention service for the host's options, or none when it sets no retention. A setting the
 * host cannot keep stops the boot, naming it: no `dataDir` to keep files in, or an age or period
 * that is not a positive whole number of milliseconds.
 */
export function retentionServices(
	retention: AttachmentRetention | undefined,
	dataDir: string | undefined,
	attachments: AttachmentPort,
	logger: Logger,
): Service[] {
	if (!retention) return [];
	if (dataDir === undefined)
		throw new PluginError(
			"attachments.retention needs a dataDir: set dataDir in the configuration, or the dataDir option of the host.",
		);
	if (attachments.expireUsed === undefined)
		throw new PluginError(
			"attachments.retention needs an attachment port with expireUsed; this one has none.",
		);
	for (const [key, value] of Object.entries(retention))
		if (!Number.isInteger(value) || value < 1)
			throw new PluginError(
				`attachments.retention.${key} must be a positive whole number of milliseconds; got ${String(value)}.`,
			);
	return [retentionService(attachments, retention, logger)];
}
