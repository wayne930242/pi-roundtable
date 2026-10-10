import type { AttachmentPort } from "../contract/attachments.ts";
import { PluginError } from "../errors.ts";
import type { Logger } from "../log.ts";
import {
	AttachmentStore,
	type AttachmentStoreOptions,
} from "./attachment-store.ts";

/**
 * The attachment port a plugin gets as `context.attachments`: over the host's `dataDir`, or, when
 * the host has none, a port whose every call throws a PluginError naming the option to set.
 */
export function attachmentPort(options: {
	dataDir: string | undefined;
	registry: AttachmentStoreOptions["registry"];
	logger: Logger;
}): AttachmentPort {
	const { dataDir, registry, logger } = options;
	if (dataDir === undefined) {
		const refuse = (): never => {
			throw new PluginError(
				"no dataDir is configured, so attachments cannot be kept. Set dataDir in the configuration, or the dataDir option of the host.",
			);
		};
		return {
			save: refuse,
			turnAttachments: refuse,
			remove: refuse,
			discardPending: refuse,
			pendingBytes: refuse,
		};
	}
	return new AttachmentStore({ dataDir, registry, logger });
}
