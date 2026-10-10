import type { Logger } from "./log.ts";
import type { ServiceStartedEvent } from "./plugin.ts";
import type { Registry } from "./registry/contributions.ts";

type Attempt = { ok: true } | { ok: false; error: unknown };

/** Runs one step whose failure the caller reports and moves past. */
export async function attempt(
	step: () => Promise<void> | void,
): Promise<Attempt> {
	try {
		await step();
		return { ok: true };
	} catch (error) {
		return { ok: false, error };
	}
}

/**
 * Runs every service's background start at once and tells every plugin, as each ends, how it
 * went; the rest of the process runs either way, and a failing start or handler never stops the
 * others.
 */
export async function startInBackground(
	registry: Registry,
	logger: Logger,
): Promise<void> {
	const { services, servicePlugins, handlers } = registry;
	await Promise.all(
		// pi-lens-ignore: array-callback-return — an async callback returns its promise on every path; map only starts the tasks for Promise.all, and the early return skips a service with no background start
		services.map(async (service) => {
			if (!service.startInBackground) return;
			const plugin = servicePlugins.get(service) ?? "unknown";
			const started = await attempt(() => service.startInBackground?.());
			if (started.ok) logger.info({ plugin, service: service.name }, "ready");
			else
				logger.error(
					{ plugin, service: service.name, err: started.error },
					"service did not start in the background",
				);
			const event: ServiceStartedEvent = {
				plugin,
				service: service.name,
				outcome: started.ok ? "ready" : "failed",
			};
			for (const { plugin: heard, events } of handlers) {
				const handled = await attempt(() => events.serviceStarted?.(event));
				if (!handled.ok)
					logger.error(
						{ plugin: heard, err: handled.error },
						"service started handler failed",
					);
			}
		}),
	);
}
