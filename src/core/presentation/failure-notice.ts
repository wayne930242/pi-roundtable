import { TurnTimeoutError } from "../domain/turn-timeout.ts";
import { messages } from "../i18n/index.ts";

/** What a failed turn posts: the stopped notice for a stop, the reason for a time limit, else the failure notice. */
export function failureNotice(result: {
	error: Error;
	stopped?: true;
}): string {
	if (result.stopped) return messages().stoppedNotice;
	if (result.error instanceof TurnTimeoutError)
		return messages().turnTimedOutNotice(result.error.timeout);
	return messages().failureNotice;
}
