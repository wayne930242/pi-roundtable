// What the overview does with a selection of stored conversations: start each over, or delete each for
// good. Each goes through the route a single conversation has, and a busy one answers `busy` (409).

import type { ConversationView } from "../../src/api-types.ts";
import { api } from "./api.ts";
import type { Batch } from "./batch.ts";
import { plural, translate as t } from "./messages.ts";

export function startOverBatch(
	items: readonly ConversationView[],
	nameOf: (item: ConversationView) => string,
	after: () => void,
): Batch<ConversationView> {
	return {
		label: t("Starting over"),
		items,
		nameOf,
		run: (item) => api.startOver(item.key),
		said: (count) =>
			plural(
				count,
				"Started {count} conversation over",
				"Started {count} conversations over",
			),
		after,
	};
}

export function deleteConversationsBatch(
	items: readonly ConversationView[],
	nameOf: (item: ConversationView) => string,
	after: () => void,
): Batch<ConversationView> {
	return {
		label: t("Deleting"),
		items,
		nameOf,
		run: (item) => api.deleteConversation(item.key),
		said: (count) =>
			plural(
				count,
				"Deleted {count} conversation",
				"Deleted {count} conversations",
			),
		after,
	};
}
