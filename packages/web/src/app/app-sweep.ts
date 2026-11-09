import type { Logger } from "pi-roundtable";
import type { HostApp } from "../host/host-app.ts";
import type { Uploads } from "./uploads.ts";

/** Deletes the app's old files and the host rooms' history past retention; a failure is logged, never thrown. */
export function sweepApp(
	uploads: Uploads,
	host: HostApp,
	logger: Logger,
): void {
	try {
		const dropped = uploads.sweep();
		if (dropped > 0) logger.info({ dropped }, "old app files deleted");
	} catch (error) {
		logger.warn({ err: error }, "old app files not deleted");
	}
	host.sweep().then(
		(gone) => {
			if (gone.messages + gone.cards + gone.files > 0)
				logger.info(gone, "host room history past retention deleted");
		},
		(error: unknown) =>
			logger.warn({ err: error }, "host room history not swept"),
	);
}
