import { ZH_TW_APP } from "./zh-tw-app.ts";
import { ZH_TW_BATCH } from "./zh-tw-batch.ts";
import { ZH_TW_KNIGHTS } from "./zh-tw-knights.ts";
import { ZH_TW_PEOPLE } from "./zh-tw-people.ts";
import { ZH_TW_SETTINGS } from "./zh-tw-settings.ts";
import { ZH_TW_WEBHOOKS } from "./zh-tw-webhooks.ts";

/** Built-in zh-TW wording keyed by the English source strings, a host's `presentation.messages` winning key by key; a class, part or palette is `character.<kind>.<id>`, what a class suits `character.jobs.<id>`. */
export const ZH_TW: Readonly<Record<string, string>> = {
	...ZH_TW_WEBHOOKS,
	...ZH_TW_APP,
	...ZH_TW_BATCH,
	...ZH_TW_KNIGHTS,
	...ZH_TW_SETTINGS,
	...ZH_TW_PEOPLE,
};
