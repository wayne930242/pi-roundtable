import type { ListenerAddress, Logger } from "pi-roundtable";
import { PluginError } from "pi-roundtable";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Refuses an address `auth: none` must not serve on, and warns about the rest, at every start.
 * A unix socket passes, a TCP listener only on a loopback hostname unless `trustNetwork`: no
 * hostname means every interface.
 */
export function checkNoneListener(
	listener: string,
	address: Readonly<ListenerAddress> | undefined,
	trustNetwork: boolean,
	logger: Logger,
): void {
	if (!address)
		throw new PluginError(
			`pi-roundtable-web: auth none needs the listener ${listener} to read its address, and the host has no such listener`,
		);
	if ("socketPath" in address) {
		if ((address.mode ?? 0o660) & 0o002)
			logger.warn(
				{ listener, socketPath: address.socketPath },
				"web-console: the listener's socket is writable by every user of this machine, and auth none makes each of them the owner",
			);
	} else if (
		!trustNetwork &&
		!LOOPBACK.has((address.hostname ?? "").toLowerCase())
	)
		throw new PluginError(
			`pi-roundtable-web: auth none on listener ${listener} would serve the owner's console to ${address.hostname ?? "every interface"}. Bind a unix socket or 127.0.0.1, or set auth.trustNetwork: true if a network in front of it keeps everyone else out`,
		);
	logger.warn(
		{ listener },
		"web-console: auth none, so whoever reaches the listener is the owner, including an agent whose shell runs as this user; only a verifier resists that (README, Threat model)",
	);
}
